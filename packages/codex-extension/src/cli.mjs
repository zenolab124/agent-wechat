#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeWeChatClient } from '@agent-wechat/shared/native-source';
import { Bridge, validateConfig } from './bridge.mjs';
import { CodexClient } from './codex.mjs';
import { StateStore } from './state.mjs';
import { usageSnapshot } from './usage.mjs';
import { writeContextView } from './context-view.mjs';
import { startDebugServer } from './debug-server.mjs';

const [command, configPath, requestedGroup] = process.argv.slice(2);
if (!['doctor', 'run', 'codex-test', 'usage', 'context', 'debug'].includes(command) || !configPath) {
  console.error('Usage: wx-codex doctor|run|codex-test|usage|context|debug /absolute/private/config.json [groupId|debugPort]'); process.exit(2);
}
let store; let codex; let debugServer;
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { controller.abort(); codex?.close(); });
try {
  const config = validateConfig(JSON.parse(readFileSync(resolve(configPath), 'utf8')), { bootstrap: command !== 'run' });
  if (command === 'debug') {
    delete process.env.AGENT_WECHAT_TOKEN;
    const port = requestedGroup === undefined ? 16175 : Number(requestedGroup);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Debug port must be between 1024 and 65535');
    codex = new CodexClient({ cwd: join(config.stateDir, 'worker'), binary: config.codexBinary, model: config.model, disabledMcp: config.disabledMcp, codexHome: config.codexHome });
    await codex.start();
    debugServer = await startDebugServer({ config, codex, port });
    console.log(JSON.stringify({ event: 'debug.ready', url: `http://127.0.0.1:${port}` }));
    await new Promise(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener('abort', resolve, { once: true }); });
  } else if (command === 'usage') {
    const snapshot = JSON.parse(readFileSync(join(config.stateDir, 'state.json'), 'utf8'));
    const binding = { baseUrl: config.baseUrl, accountId: config.accountId, ownUsername: config.ownUsername };
    if (JSON.stringify(snapshot.binding) !== JSON.stringify(binding)) throw Error('Usage/account binding mismatch');
    if (![2, 3].includes(snapshot.schema) || !snapshot.usage?.groups) throw Error('Usage statistics have not been initialized');
    console.log(JSON.stringify(usageSnapshot(snapshot), null, 2));
  } else if (command === 'context') {
    delete process.env.AGENT_WECHAT_TOKEN;
    const snapshot = JSON.parse(readFileSync(join(config.stateDir, 'state.json'), 'utf8'));
    const binding = { baseUrl: config.baseUrl, accountId: config.accountId, ownUsername: config.ownUsername };
    if (JSON.stringify(snapshot.binding) !== JSON.stringify(binding)) throw Error('Context/account binding mismatch');
    const group = requestedGroup ?? (config.groups.length === 1 ? config.groups[0].id : null);
    if (!config.groups.some(item => item.id === group) || !snapshot.conversations?.[group]) throw Error('Select a configured group with an existing conversation');
    codex = new CodexClient({ cwd: join(config.stateDir, 'worker'), binary: config.codexBinary, model: config.model, disabledMcp: config.disabledMcp, codexHome: config.codexHome });
    await codex.start();
    console.log(JSON.stringify({ event: 'context.view', path: await writeContextView(codex, config.stateDir, group, snapshot.conversations[group]) }));
  } else {
    const token = process.env.AGENT_WECHAT_TOKEN;
    if (!token) throw Error('Provide the daemon token privately through AGENT_WECHAT_TOKEN');
    delete process.env.AGENT_WECHAT_TOKEN;
    const client = new NativeWeChatClient({ baseUrl: config.baseUrl, token });
    const account = await client.account(config.accountId);
    if (command === 'doctor') {
      const status = await client.status();
      console.log(JSON.stringify({ event: 'doctor', daemon: status, authenticated: account.authenticated, identityMatches: account.ownUsername === config.ownUsername, sendEnabled: config.sendEnabled === true }));
    } else {
      if (!config.stateDir || !config.stateDir.startsWith('/')) throw Error('An absolute private stateDir is required');
      const cwd = join(config.stateDir, 'worker'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
      codex = new CodexClient({ cwd, binary: config.codexBinary, model: config.model, disabledMcp: config.disabledMcp, codexHome: config.codexHome });
      await codex.start();
      if (command === 'codex-test') {
        const answer = await codex.answer({ history: [], message: { sender: 'local-test', text: '请回复：Codex 扩展连接成功。' }, mode: 'prefix' });
        console.log(JSON.stringify({ event: 'codex.test', answer }));
      } else {
        store = new StateStore(config.stateDir, { baseUrl: config.baseUrl, accountId: config.accountId, ownUsername: config.ownUsername });
        const bridge = new Bridge({ client, codex, store, config, signal: controller.signal, report: value => console.log(JSON.stringify(value)),
          afterAnswer: config.persistentConversations ? group => writeContextView(codex, config.stateDir, group, store.data.conversations[group]) : undefined });
        await bridge.identity();
        console.log(JSON.stringify({ event: 'worker.ready', sendEnabled: config.sendEnabled === true }));
        while (!controller.signal.aborted) {
          await bridge.identity();
          const page = await client.events(config.accountId, store.data.cursor, 100);
          for (const event of page.items) await bridge.accept(event);
          await bridge.drain();
          await delay(config.pollIntervalMs, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
        }
      }
    }
  }
} catch (error) {
  // Do not mirror upstream error bodies, messages or credentials into service logs.
  console.error(JSON.stringify({ event: 'worker.stopped', error: error.name, code: error.code ?? null })); process.exitCode = controller.signal.aborted ? 0 : 1;
} finally { debugServer?.closeAllConnections(); debugServer?.close(); codex?.close(); store?.close(); }

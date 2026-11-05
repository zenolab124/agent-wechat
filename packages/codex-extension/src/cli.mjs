#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeWeChatClient } from '@agent-wechat/shared/native-source';
import { Bridge, validateConfig } from './bridge.mjs';
import { CodexClient } from './codex.mjs';
import { StateStore } from './state.mjs';

const [command, configPath] = process.argv.slice(2);
if (!['doctor', 'run', 'codex-test'].includes(command) || !configPath) {
  console.error('Usage: wx-codex doctor|run|codex-test /absolute/private/config.json'); process.exit(2);
}
let store; let codex;
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort());
try {
  const config = validateConfig(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
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
    codex = new CodexClient({ cwd, binary: config.codexBinary, model: config.model, disabledMcp: config.disabledMcp });
    await codex.start();
    if (command === 'codex-test') {
      const answer = await codex.answer({ history: [], message: { sender: 'local-test', text: '请回复：Codex 扩展连接成功。' }, mode: 'prefix' });
      console.log(JSON.stringify({ event: 'codex.test', answer }));
    } else {
      store = new StateStore(config.stateDir, { baseUrl: config.baseUrl, accountId: config.accountId, ownUsername: config.ownUsername });
      const bridge = new Bridge({ client, codex, store, config, report: value => console.log(JSON.stringify(value)) });
      await bridge.identity();
      console.log(JSON.stringify({ event: 'worker.ready', sendEnabled: config.sendEnabled === true }));
      while (!controller.signal.aborted) {
        await bridge.identity();
        const page = await client.events(config.accountId, store.data.cursor, 100);
        for (const event of page.items) await bridge.accept(event);
        await bridge.drain();
        await delay(1000, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
  }
} catch (error) {
  // Do not mirror upstream error bodies, messages or credentials into service logs.
  console.error(JSON.stringify({ event: 'worker.stopped', error: error.name, code: error.code ?? null })); process.exitCode = 1;
} finally { codex?.close(); store?.close(); }

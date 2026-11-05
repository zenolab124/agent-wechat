import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenUsage } from './usage.mjs';
import { GROUP_INSTRUCTIONS, OUTPUT_INSTRUCTIONS } from './instructions.mjs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function workerArgs(disabledMcp = []) {
  const settings = {
    'features.apps': false, 'features.shell_tool': false, 'features.unified_exec': false,
    'features.multi_agent': false, 'features.image_generation': false, 'features.view_image': false,
    'features.in_app_browser': false, 'features.in_app_local_automation': false,
    'features.skill_search': false, 'features.skip_host_skill_discovery': true,
    'skills.include_instructions': false, project_doc_max_bytes: 0, web_search: 'disabled',
    include_environment_context: false, include_permissions_instructions: false,
    include_collaboration_mode_instructions: false, include_apps_instructions: false,
    personality: 'none', 'features.memories': false, 'skills.bundled.enabled': false,
  };
  for (const name of disabledMcp) {
    settings[`mcp_servers.${name}.enabled`] = false;
    // Host-provided servers may not have a config table. Supply a valid, disabled
    // stdio transport so declaring that table does not create an invalid server.
    settings[`mcp_servers.${name}.command`] = 'node';
  }
  return ['app-server', '--listen', 'stdio://', ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
}

export class CodexClient {
  constructor({ binary = 'codex', cwd, disabledMcp = [], model, codexHome, timeoutMs = 120000 } = {}) {
    Object.assign(this, { binary, cwd, disabledMcp, model, codexHome, timeoutMs });
    this.profile = resolve(codexHome ?? process.env.CODEX_HOME ?? `${homedir()}/.codex`);
    this.pending = new Map(); this.turns = new Map(); this.sequence = 0;
  }
  async start() {
    const args = workerArgs(this.disabledMcp);
    if (this.codexHome) args.push('-c', 'cli_auth_credentials_store="keyring"');
    this.child = spawn(this.binary, args, { cwd: this.cwd, env: { ...process.env, ...(this.codexHome ? { CODEX_HOME: this.profile } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      this.onMessage(message);
    });
    this.child.on('error', () => this.failAll(Error('Codex could not start')));
    this.child.on('exit', () => this.failAll(Error('Codex exited')));
    await this.request('initialize', { clientInfo: { name: 'agent-wechat-codex', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
    const auth = await this.readAccount();
    if (!auth.account) throw Error('Codex needs its own login');
    const tools = await this.request('mcpServerStatus/list', {});
    if (tools.nextCursor || tools.data?.some(server => server.tools && Object.keys(server.tools).length)) throw Error('Disable every external MCP server for the chat worker');
  }
  async readAccount() {
    for (let attempt = 0; ; attempt++) {
      try { return await this.request('account/read', { refreshToken: false }); }
      catch (error) {
        if (!error.accountReadTimeout || attempt >= 2) throw error;
        await delay(250 * (attempt + 1));
      }
    }
  }
  write(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return Promise.reject(Error('Codex is not running'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Codex request timed out: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ id, method, params });
    });
  }
  onMessage(message) {
    const pending = this.pending.get(message.id);
    if (pending && !message.method) {
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) {
        const error = Error(`Codex ${pending.method} RPC error ${message.error.code}`);
        const text = String(message.error.message ?? '');
        error.accountReadTimeout = pending.method === 'account/read' && message.error.code === -32603
          && /timed out|timeout/i.test(text) && !/unauthorized|forbidden|expired|invalid.*(?:token|credential)|authentication failed/i.test(text);
        error.code = error.accountReadTimeout ? 'CODEX_ACCOUNT_READ_TIMEOUT' : 'CODEX_RPC_FAILED';
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.write({ id: message.id, error: { code: -32601, message: 'No tools or approvals are available to this conversation worker' } }); return;
    }
    const params = message.params ?? {};
    const turn = this.turns.get(params.threadId);
    if (!turn) return;
    if (!['thread/tokenUsage/updated', 'item/completed', 'turn/completed'].includes(message.method)) return;
    if (turn.awaitingStart) {
      if (turn.buffer.length >= 64) { turn.reject(Error('Too many events before turn identity confirmation')); return; }
      turn.buffer.push(message); return;
    }
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (turn.strictTurnId && eventTurnId !== turn.turnId) return;
    if (message.method === 'thread/tokenUsage/updated' && (!turn.turnId || params.turnId === turn.turnId)) {
      // Persistent threads report cumulative totals too. This tool-free worker
      // performs one inference per turn, so use only that turn's last request.
      const usage = tokenUsage(params.tokenUsage?.[turn.usageMode === 'last' ? 'last' : 'total']);
      if (usage && (!turn.usage || usage.totalTokens >= turn.usage.totalTokens)) turn.usage = usage;
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase === 'final_answer') turn.text = params.item.text;
    if (message.method === 'turn/completed') {
      clearTimeout(turn.timer); this.turns.delete(params.threadId);
      if (params.turn?.status !== 'completed' || !turn.text?.trim()) turn.reject(Object.assign(Error('Codex final answer incomplete'), { usage: turn.usage ?? null }));
      else {
        try {
          const decision = JSON.parse(turn.text.trim());
          if (typeof decision.reply !== 'boolean') throw Error();
          turn.resolve({ reply: decision.reply, ...(decision.reply ? { text: decision.text } : {}), usage: turn.usage ?? null });
        } catch { turn.reject(Object.assign(Error('Codex final answer is not a reply decision'), { usage: turn.usage ?? null })); }
      }
    }
  }
  async answer(context, options = {}) {
    if (options.conversation && options.conversation.profile !== this.profile) throw Error('Conversation belongs to another Codex profile');
    const settings = {
      cwd: this.cwd, model: this.model ?? null, sandbox: 'read-only', approvalPolicy: 'never',
      runtimeWorkspaceRoots: [], baseInstructions: GROUP_INSTRUCTIONS, developerInstructions: OUTPUT_INSTRUCTIONS,
    };
    const result = options.conversation
      ? await this.request('thread/resume', { ...settings, threadId: options.conversation.threadId, excludeTurns: true })
      : await this.request('thread/start', { ...settings, environments: [], selectedCapabilityRoots: [], dynamicTools: [], ephemeral: !options.persist, historyMode: 'paginated' });
    const threadId = result.thread.id;
    try {
      if (result.instructionSources?.length) throw Error('Unexpected instruction files loaded; refusing group inference');
      if (options.conversation && threadId !== options.conversation.threadId) throw Error('Resumed conversation identity mismatch');
      if (options.persist) {
        await options.onThread?.({ threadId, profile: this.profile });
        if (!options.conversation && options.title) await this.request('thread/name/set', { threadId, name: options.title });
      }
      const final = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const turn = this.turns.get(threadId); this.turns.delete(threadId);
          if (turn?.turnId) this.request('turn/interrupt', { threadId, turnId: turn.turnId }).catch(() => {});
          reject(Object.assign(Error('Codex answer timed out'), { usage: turn?.usage ?? null }));
        }, this.timeoutMs);
        this.turns.set(threadId, { resolve, reject, timer, text: '', usage: null,
          awaitingStart: true, buffer: [], strictTurnId: true, usageMode: options.persist ? 'last' : 'total' });
      });
      final.catch(() => {});
      const started = await this.request('turn/start', { threadId, input: [{ type: 'text', text: JSON.stringify(context) }], environments: [], runtimeWorkspaceRoots: [], effort: 'low' });
      const turn = this.turns.get(threadId);
      if (turn) { turn.turnId = started.turn.id; turn.awaitingStart = false; const buffer = turn.buffer; turn.buffer = []; for (const event of buffer) this.onMessage(event); }
      return await final;
    } catch (error) {
      error.usage ??= this.turns.get(threadId)?.usage ?? null;
      throw error;
    } finally {
      const turn = this.turns.get(threadId);
      if (turn) { clearTimeout(turn.timer); this.turns.delete(threadId); turn.reject(Error('Turn stopped')); }
      await this.request('thread/unsubscribe', { threadId }).catch(() => {});
    }
  }
  async readConversation(threadId) {
    const { thread } = await this.request('thread/read', { threadId });
    if (thread.id !== threadId || thread.ephemeral) throw Error('Conversation is not the requested persistent thread');
    const turns = []; let cursor = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.request('thread/turns/list', { threadId, cursor, limit: 50, sortDirection: 'asc', itemsView: 'full' });
      if (!Array.isArray(result.data)) throw Error('Invalid conversation history page');
      turns.push(...result.data); if (!result.nextCursor) return { thread, turns };
      if (result.nextCursor === cursor) throw Error('Conversation pagination did not advance');
      cursor = result.nextCursor;
    }
    throw Error('Conversation exceeds viewer limit; use paginated history');
  }
  failAll(error) {
    for (const entry of [...this.pending.values(), ...this.turns.values()]) {
      clearTimeout(entry.timer); entry.reject(Object.assign(Error(error.message), { usage: entry.usage ?? null }));
    }
    this.pending.clear(); this.turns.clear();
  }
  close() { this.failAll(Error('Worker stopped')); this.child?.stdin.end(); this.child?.kill(); }
}

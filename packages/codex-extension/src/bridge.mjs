import { createHash } from 'node:crypto';

export function validateConfig(value, { bootstrap = false } = {}) {
  const url = new URL(value.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Use an explicit loopback daemon URL');
  if (typeof value.accountId !== 'string' || !value.accountId) throw Error('Pin the daemon account');
  if (!bootstrap && (typeof value.ownUsername !== 'string' || !value.ownUsername)) throw Error('Pin the signed-in WeChat identity');
  if (!Array.isArray(value.groups) || !bootstrap && !value.groups.length) throw Error('At least one explicit test group is required');
  const seen = new Set();
  for (const group of value.groups) {
    if (typeof group.id !== 'string' || !group.id.endsWith('@chatroom') || seen.has(group.id)
      || !Array.isArray(group.senders) || !group.senders.length || group.senders.some(id => typeof id !== 'string' || !id || id === '*')
      || !['prefix', 'selective'].includes(group.mode) || (group.mode === 'prefix' && (typeof group.prefix !== 'string' || !group.prefix.trim()))) throw Error('Invalid exact group/sender policy');
    seen.add(group.id);
  }
  if (value.sendEnabled !== undefined && typeof value.sendEnabled !== 'boolean') throw Error('sendEnabled must be boolean');
  if (value.cooldownMs !== undefined && (!Number.isSafeInteger(value.cooldownMs) || value.cooldownMs < 1000)) throw Error('cooldownMs must be at least 1000');
  if (value.disabledMcp !== undefined && (!Array.isArray(value.disabledMcp) || value.disabledMcp.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)))) throw Error('Invalid MCP names');
  return { cooldownMs: 10000, ...value, baseUrl: url.origin };
}

export function replyKey(accountId, messageId, version) {
  return `codex-${createHash('sha256').update(JSON.stringify([accountId, messageId, version])).digest('hex')}`;
}

export class Bridge {
  constructor({ client, codex, store, config, report = () => {}, signal }) {
    Object.assign(this, { client, codex, store, config: validateConfig(config), report, signal });
  }
  async identity() {
    this.signal?.throwIfAborted();
    const account = await this.client.account(this.config.accountId);
    this.signal?.throwIfAborted();
    if (account.id !== this.config.accountId || account.authenticated !== true || account.ownUsername !== this.config.ownUsername) throw Error('WeChat account is signed out or its identity changed');
  }
  policy(message) {
    const group = this.config.groups.find(group => group.id === message.threadId);
    if (message.accountId !== this.config.accountId || message.direction !== 'incoming' || message.senderId === this.config.ownUsername
      || !group?.senders.includes(message.senderId) || message.type !== 1 || typeof message.body !== 'string' || !message.body.trim() || message.recall
      || !message.createdAt || Date.parse(message.createdAt) < Date.parse(this.store.data.activatedAt) || !Number.isFinite(Date.parse(message.createdAt))
      || Date.now() - Date.parse(message.createdAt) > 300000 || Date.parse(message.createdAt) - Date.now() > 60000) return null;
    if (group.mode === 'prefix' && !message.body.trimStart().startsWith(group.prefix)) return null;
    return group;
  }
  async accept(event) {
    if (!/^\d+$/.test(event.cursor)) throw Error('Invalid event cursor');
    if (BigInt(event.cursor) <= BigInt(this.store.data.cursor)) return;
    if (event.kind === 'message.committed' && event.data.origin === 'live') {
      if (typeof event.data.messageId !== 'string') throw Error('Missing committed message ID');
      const message = await this.client.message(this.config.accountId, event.data.messageId);
      if (message.id !== event.data.messageId || message.accountId !== this.config.accountId || message.threadId !== event.data.threadId) throw Error('Message/event identity mismatch');
      if (this.policy(message)) {
        const key = replyKey(message.accountId, message.id, message.version);
        this.store.data.tasks[key] ??= { key, messageId: message.id, version: message.version, threadId: message.threadId, state: 'pending' };
      }
    }
    this.store.data.cursor = event.cursor;
    // Completed entries are only replay metadata; pending/uncertain sends are retained.
    const settled = Object.keys(this.store.data.tasks).filter(key => ['done', 'ignored', 'dry-run'].includes(this.store.data.tasks[key].state));
    for (const key of settled.slice(0, Math.max(0, settled.length - 2000))) delete this.store.data.tasks[key];
    this.store.save();
  }
  async drain() {
    for (const task of Object.values(this.store.data.tasks)) {
      if (['pending', 'prepared', 'submitting', 'submitted', 'unknown'].includes(task.state)) await this.process(task);
    }
  }
  async settle(task, intent) {
    if (intent.accountId !== this.config.accountId || intent.destination !== task.threadId) throw Error('Send receipt account/destination mismatch');
    task.sendId = intent.id;
    task.receiptState = intent.state;
    // Preserve any unrecognized/uncertain state; never resubmit it.
    if (intent.state === 'accepted') {
      task.state = 'done'; delete task.reply;
      this.store.data.lastReply[task.threadId] = Date.now();
    } else if (['failed', 'cancelled', 'canceled', 'rejected'].includes(intent.state)) {
      task.state = 'failed'; delete task.reply;
    } else task.state = 'submitted';
    this.store.save();
    this.report({ event: 'reply.receipt', state: task.state, receiptState: intent.state });
  }
  async process(task) {
    await this.identity();
    if (['submitting', 'submitted', 'unknown'].includes(task.state)) {
      // The POST may already have reached WeChat. A missing receipt is not permission to retry.
      try { await this.settle(task, task.sendId ? await this.client.send(this.config.accountId, task.sendId) : await this.client.sendByKey(this.config.accountId, task.key)); }
      catch { task.state = 'unknown'; this.store.save(); }
      return;
    }
    if (Object.values(this.store.data.tasks).some(other => other !== task && other.threadId === task.threadId
      && ['submitting', 'submitted', 'unknown'].includes(other.state))) return;
    const current = await this.client.message(this.config.accountId, task.messageId);
    const group = this.policy(current);
    if (!group || current.id !== task.messageId || current.version !== task.version || current.threadId !== task.threadId) { task.state = 'ignored'; delete task.reply; this.store.save(); return; }
    if (task.state === 'pending') {
      if (Date.now() - (this.store.data.lastReply[task.threadId] ?? 0) < this.config.cooldownMs) return;
      const page = await this.client.messages(this.config.accountId, task.threadId, { limit: 12 });
      const history = page.items.filter(item => item.accountId === this.config.accountId && item.threadId === task.threadId && item.type === 1 && !item.recall && item.id !== current.id
        && (item.direction === 'incoming' && group.senders.includes(item.senderId) || item.direction === 'outgoing' && item.senderId === this.config.ownUsername))
        .map(item => ({ sender: item.senderId, text: item.body?.slice(0, 2000), at: item.createdAt })).reverse();
      const decision = await this.codex.answer({ history, message: { sender: current.senderId, text: current.body.slice(0, 4000) }, mode: group.mode });
      if (!decision.reply) { task.state = 'ignored'; this.store.save(); return; }
      if (typeof decision.text !== 'string' || !decision.text.trim() || decision.text.length > 1600) throw Error('Codex returned invalid bounded reply');
      task.reply = decision.text.trim(); task.state = 'prepared'; this.store.save();
    }
    if (!this.config.sendEnabled) { task.state = 'dry-run'; delete task.reply; this.store.save(); this.report({ event: 'reply.dry-run' }); return; }
    await this.identity();
    const recheck = await this.client.message(this.config.accountId, task.messageId);
    this.signal?.throwIfAborted();
    if (!this.policy(recheck) || recheck.id !== task.messageId || recheck.version !== task.version || recheck.threadId !== task.threadId) { task.state = 'ignored'; delete task.reply; this.store.save(); return; }
    task.state = 'submitting'; this.store.save();
    try { await this.settle(task, await this.client.sendText(this.config.accountId, task.threadId, task.reply, task.key)); }
    catch { task.state = 'unknown'; this.store.save(); this.report({ event: 'reply.unknown' }); }
  }
}

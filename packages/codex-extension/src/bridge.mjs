import { createHash } from 'node:crypto';
import { groupUsage, recordResult } from './usage.mjs';

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
  const settings = { callIntervalMs: 30000, maxCallsPerHour: 6, batchWindowMs: 3000, batchMaxWaitMs: 10000, batchMaxMessages: 12, ...value };
  for (const [name, min, max] of [['callIntervalMs', 1000, 3600000], ['maxCallsPerHour', 1, 10000], ['batchWindowMs', 0, 30000], ['batchMaxWaitMs', 0, 60000], ['batchMaxMessages', 1, 32]]) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < min || settings[name] > max) throw Error(`Invalid ${name}`);
  }
  if (settings.batchMaxWaitMs < settings.batchWindowMs) throw Error('batchMaxWaitMs must cover batchWindowMs');
  if (value.disabledMcp !== undefined && (!Array.isArray(value.disabledMcp) || value.disabledMcp.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)))) throw Error('Invalid MCP names');
  return { cooldownMs: 10000, ...settings, baseUrl: url.origin };
}

export function replyKey(accountId, messageId, version) {
  return `codex-${createHash('sha256').update(JSON.stringify([accountId, messageId, version])).digest('hex')}`;
}

export function messageFingerprint(message) {
  return createHash('sha256').update(JSON.stringify([message.id, message.accountId, message.threadId, message.serverId ?? null,
    message.senderId, message.direction, message.type, message.body, message.createdAt, message.recall ?? null])).digest('hex');
}

const terminal = new Set(['done', 'ignored', 'dry-run', 'rate-limited', 'generation-failed', 'generation-unknown']);

export class Bridge {
  constructor({ client, codex, store, config, report = () => {}, signal, now = Date.now }) {
    Object.assign(this, { client, codex, store, config: validateConfig(config), report, signal, now });
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
      || this.now() - Date.parse(message.createdAt) > 300000 || Date.parse(message.createdAt) - this.now() > 60000) return null;
    if (group.mode === 'prefix' && !message.body.trimStart().startsWith(group.prefix)) return null;
    return group;
  }
  async accept(event) {
    if (!/^\d+$/.test(event.cursor)) throw Error('Invalid event cursor');
    if (BigInt(event.cursor) <= BigInt(this.store.data.cursor)) return;
    if (event.kind === 'message.committed' && event.data.origin === 'live'
      && this.config.groups.some(group => group.id === event.data.threadId)) {
      if (typeof event.data.messageId !== 'string') throw Error('Missing committed message ID');
      const message = await this.client.message(this.config.accountId, event.data.messageId);
      if (message.id !== event.data.messageId || message.accountId !== this.config.accountId || message.threadId !== event.data.threadId) throw Error('Message/event identity mismatch');
      if (this.policy(message)) {
        const key = replyKey(message.accountId, message.id, message.version);
        const tasks = Object.values(this.store.data.tasks);
        if (!tasks.some(task => (task.inputs ?? [task]).some(input => input.messageId === message.id))) {
          const now = this.now();
          const ref = { messageId: message.id, version: message.version, fingerprint: messageFingerprint(message), chars: Math.min(4000, message.body.length) };
          const batch = this.config.batchWindowMs > 0 && tasks.find(task => task.state === 'pending' && task.threadId === message.threadId
            && task.inputs && now - task.firstReceivedAt < this.config.batchMaxWaitMs
            && now - task.lastReceivedAt <= this.config.batchWindowMs && task.inputs.length < this.config.batchMaxMessages
            && task.inputs.reduce((sum, input) => sum + input.chars, 0) + ref.chars <= 8000);
          const usage = groupUsage(this.store.data, message.threadId); usage.observedMessages++;
          if (batch) { batch.inputs.push(ref); batch.lastReceivedAt = now; usage.mergedMessages++; }
          else this.store.data.tasks[key] = { key, messageId: message.id, version: message.version, threadId: message.threadId,
            state: 'pending', inputs: [ref], firstReceivedAt: now, lastReceivedAt: now };
        }
      }
    }
    this.store.data.cursor = event.cursor;
    // Completed entries are only replay metadata; pending/uncertain sends are retained.
    const settled = Object.keys(this.store.data.tasks).filter(key => terminal.has(this.store.data.tasks[key].state));
    for (const key of settled.slice(0, Math.max(0, settled.length - 2000))) delete this.store.data.tasks[key];
    this.store.save();
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const task of Object.values(this.store.data.tasks)) {
        if (['pending', 'sealed', 'prepared', 'submitting', 'submitted', 'unknown'].includes(task.state)) await this.process(task);
      }
    } finally { this.draining = false; }
  }
  async settle(task, intent) {
    if (intent.accountId !== this.config.accountId || intent.destination !== task.threadId) throw Error('Send receipt account/destination mismatch');
    task.sendId = intent.id;
    task.receiptState = intent.state;
    // Preserve any unrecognized/uncertain state; never resubmit it.
    if (intent.state === 'accepted') {
      task.state = 'done'; delete task.reply;
      this.store.data.lastReply[task.threadId] = this.now();
      if (!task.receiptCounted) { groupUsage(this.store.data, task.threadId).repliesAccepted++; task.receiptCounted = true; }
    } else if (['failed', 'cancelled', 'canceled', 'rejected'].includes(intent.state)) {
      task.state = 'failed'; delete task.reply;
    } else task.state = 'submitted';
    this.store.save();
    this.report({ event: 'reply.receipt', state: task.state, receiptState: intent.state });
  }
  async inputs(task) {
    const messages = [];
    for (const ref of task.inputs ?? [task]) {
      const current = await this.client.message(this.config.accountId, ref.messageId);
      if (!this.policy(current) || current.id !== ref.messageId || current.threadId !== task.threadId
        || (ref.fingerprint ? messageFingerprint(current) !== ref.fingerprint : current.version !== ref.version)) return null;
      messages.push(current);
    }
    return messages;
  }
  ignore(task) { task.state = 'ignored'; delete task.reply; this.store.save(); }
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
    const now = this.now();
    if (task.state === 'pending' && task.inputs && task.inputs.length < this.config.batchMaxMessages
      && now - task.lastReceivedAt < this.config.batchWindowMs && now - task.firstReceivedAt < this.config.batchMaxWaitMs) return;
    if (task.state === 'pending') { task.state = 'sealed'; this.store.save(); }
    const messages = await this.inputs(task);
    if (!messages?.length) { this.ignore(task); return; }
    const group = this.policy(messages[0]);
    if (task.state === 'sealed') {
      const usage = groupUsage(this.store.data, task.threadId);
      usage.callTimes = usage.callTimes.filter(at => at > now - 3600000);
      const reason = usage.callTimes.length >= this.config.maxCallsPerHour ? 'hourly'
        : usage.lastCallAt !== null && now - usage.lastCallAt < this.config.callIntervalMs ? 'interval'
        : now - (this.store.data.lastReply[task.threadId] ?? 0) < this.config.cooldownMs ? 'reply-cooldown' : null;
      if (reason) {
        task.state = 'rate-limited'; task.limitReason = reason;
        usage.rateLimitedBatches++; usage.rateLimitedMessages += messages.length;
        this.store.save(); this.report({ event: 'model.rate-limited', reason }); return;
      }
      const page = await this.client.messages(this.config.accountId, task.threadId, { limit: 12 });
      const ids = new Set(messages.map(message => message.id));
      const history = page.items.filter(item => item.accountId === this.config.accountId && item.threadId === task.threadId && item.type === 1 && !item.recall && !ids.has(item.id)
        && (item.direction === 'incoming' && group.senders.includes(item.senderId) || item.direction === 'outgoing' && item.senderId === this.config.ownUsername))
        .map(item => ({ sender: item.senderId, text: item.body?.slice(0, 2000), at: item.createdAt })).reverse();
      await this.identity();
      if (!await this.inputs(task)) { this.ignore(task); return; }
      // Reserve one call and its whole batch before any model request can leave.
      task.state = 'generating'; usage.callsStarted++; usage.lastCallAt = this.now(); usage.callTimes.push(usage.lastCallAt);
      this.store.save();
      let decision;
      try {
        decision = await this.codex.answer({ history, messages: messages.map(message => ({ sender: message.senderId, text: message.body.slice(0, 4000), at: message.createdAt })), mode: group.mode });
        if (typeof decision?.reply !== 'boolean' || decision.reply && (typeof decision.text !== 'string' || !decision.text.trim() || decision.text.length > 1600)) throw Object.assign(Error('Invalid bounded reply'), { usage: decision?.usage });
      } catch (error) {
        recordResult(this.store.data, task, error.usage, 'failed'); task.state = 'generation-failed'; this.store.save();
        this.report({ event: 'model.failed' }); throw error;
      }
      recordResult(this.store.data, task, decision.usage, 'completed');
      if (!decision.reply) { usage.silentCalls++; this.ignore(task); return; }
      task.reply = decision.text.trim(); task.state = 'prepared'; this.store.save();
    }
    if (!this.config.sendEnabled) { task.state = 'dry-run'; delete task.reply; this.store.save(); this.report({ event: 'reply.dry-run' }); return; }
    await this.identity();
    const recheck = await this.inputs(task);
    this.signal?.throwIfAborted();
    if (!recheck) { this.ignore(task); return; }
    task.state = 'submitting'; this.store.save();
    try { await this.settle(task, await this.client.sendText(this.config.accountId, task.threadId, task.reply, task.key)); }
    catch { task.state = 'unknown'; this.store.save(); this.report({ event: 'reply.unknown' }); }
  }
}

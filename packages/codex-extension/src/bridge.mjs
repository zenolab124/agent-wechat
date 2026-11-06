import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { groupUsage, recordResult } from './usage.mjs';
import { receivedQuote, quotesAssistant, quotedInput, inputChars, verifyAssistantQuote } from './quotes.mjs';
import { describeMessage, isVisualMessage } from './message-content.mjs';
import { prepareVisual } from './visuals.mjs';
import { validateEngineConfig } from './engine.mjs';
import { validateSnapConfig } from './snap.mjs';
import { validatePersona } from './persona.mjs';
import { imageDeckRequest } from './decks.mjs';

export function validateConfig(value, { bootstrap = false } = {}) {
  validatePersona(value.persona);
  validateSnapConfig(value.snap);
  validateEngineConfig(value.engine);
  if (value.engine && (!value.snap || typeof value.stateDir !== "string" || !isAbsolute(value.stateDir))) throw Error("Local engine requires SNAP data and a private stateDir");
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
    if (group.replyToAssistantQuotes !== undefined && typeof group.replyToAssistantQuotes !== 'boolean') throw Error('replyToAssistantQuotes must be boolean');
    if (group.receiveImagesAndStickers !== undefined && typeof group.receiveImagesAndStickers !== 'boolean') throw Error('receiveImagesAndStickers must be boolean');
  }
  if (value.sendEnabled !== undefined && typeof value.sendEnabled !== 'boolean') throw Error('sendEnabled must be boolean');
  if (value.persistentConversations !== undefined && typeof value.persistentConversations !== 'boolean') throw Error('persistentConversations must be boolean');
  if (value.codexHome !== undefined && (typeof value.codexHome !== 'string' || !isAbsolute(value.codexHome))) throw Error('codexHome must be absolute');
  if (value.persistentConversations && !value.codexHome) throw Error('Persistent conversations require an explicit isolated Codex profile');
  if (value.cooldownMs !== undefined && (!Number.isSafeInteger(value.cooldownMs) || value.cooldownMs < 0)) throw Error('cooldownMs must be nonnegative');
  const settings = { callIntervalMs: 0, maxCallsPerHour: 0, batchWindowMs: 3000, batchMaxWaitMs: 10000, batchMaxMessages: 12, pollIntervalMs: 1000, ...value };
  for (const [name, min, max] of [['callIntervalMs', 0, 3600000], ['maxCallsPerHour', 0, 10000], ['batchWindowMs', 0, 30000], ['batchMaxWaitMs', 0, 60000], ['batchMaxMessages', 1, 32], ['pollIntervalMs', 100, 10000]]) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < min || settings[name] > max) throw Error(`Invalid ${name}`);
  }
  if (settings.batchMaxWaitMs < settings.batchWindowMs) throw Error('batchMaxWaitMs must cover batchWindowMs');
  if (value.disabledMcp !== undefined && (!Array.isArray(value.disabledMcp) || value.disabledMcp.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)))) throw Error('Invalid MCP names');
  return { cooldownMs: 0, ...settings, baseUrl: url.origin };
}

export function replyKey(accountId, messageId, version) {
  return `codex-${createHash('sha256').update(JSON.stringify([accountId, messageId, version])).digest('hex')}`;
}

export function messageFingerprint(message) {
  return createHash('sha256').update(JSON.stringify([message.id, message.accountId, message.threadId, message.serverId ?? null,
    message.senderId, message.direction, message.type, message.body, message.createdAt, message.recall ?? null,
    ...(message.quote ? [message.appMessageType ?? null, message.quote] : []), message.mentions ?? null])).digest('hex');
}

const terminal = new Set(['done', 'ignored', 'dry-run', 'rate-limited', 'generation-failed', 'generation-unknown']);

export class Bridge {
  constructor({ client, codex, store, config, report = () => {}, afterAnswer, signal, now = Date.now }) {
    Object.assign(this, { client, codex, store, config: validateConfig(config), report, afterAnswer, signal, now });
  }
  async identity() {
    this.signal?.throwIfAborted();
    const account = await this.client.account(this.config.accountId);
    this.signal?.throwIfAborted();
    if (account.id !== this.config.accountId || account.authenticated !== true || account.ownUsername !== this.config.ownUsername) throw Error('WeChat account is signed out or its identity changed');
  }
  policy(message) {
    const group = this.config.groups.find(group => group.id === message.threadId);
    const content = describeMessage(message);
    if (!content) return null;
    const direct = group?.replyToAssistantQuotes === true && quotesAssistant(message, this.config.ownUsername);
    const quote = group?.replyToAssistantQuotes === true && receivedQuote(message);
    const deckRequest = !!group && !!this.config.snap && imageDeckRequest(message, this.config.ownUsername);
    const senderAllowed = group?.senders.includes(message.senderId) || direct || deckRequest;
    const typeAllowed = message.type === 1 || !!quote || group?.receiveImagesAndStickers === true && isVisualMessage(message);
    if (message.accountId !== this.config.accountId || message.direction !== 'incoming' || message.senderId === this.config.ownUsername
      || typeof message.senderId !== 'string' || !message.senderId
      || !senderAllowed || !typeAllowed
      || (!content.text.trim() && !direct && !isVisualMessage(message)) || message.recall
      || !message.createdAt || Date.parse(message.createdAt) < Date.parse(this.store.data.activatedAt) || !Number.isFinite(Date.parse(message.createdAt))
      || this.now() - Date.parse(message.createdAt) > 300000 || Date.parse(message.createdAt) - this.now() > 60000) return null;
    if (group.mode === 'prefix' && !content.text.trimStart().startsWith(group.prefix) && !direct && !deckRequest) return null;
    return group;
  }
  assistantQuote(message) {
    return this.config.groups.some(group => group.id === message.threadId && group.replyToAssistantQuotes === true)
      && quotesAssistant(message, this.config.ownUsername);
  }
  async eligible(message) {
    const group = this.policy(message);
    if (!group) return null;
    if (this.assistantQuote(message) && !await verifyAssistantQuote(this.client, this.config, message, this.signal)) {
      this.report({ event: 'quote.unverified' }); return null;
    }
    return group;
  }
  async accept(event) {
    if (!/^\d+$/.test(event.cursor)) throw Error('Invalid event cursor');
    if (BigInt(event.cursor) <= BigInt(this.store.data.cursor)) return;
    if (event.kind === 'message.committed' && event.data.origin === 'live'
      && this.config.groups.some(group => group.id === event.data.threadId)) {
      if (typeof event.data.messageId !== 'string') throw Error('Missing committed message ID');
      const observedAt = this.now();
      const message = await this.client.message(this.config.accountId, event.data.messageId);
      if (message.id !== event.data.messageId || message.accountId !== this.config.accountId || message.threadId !== event.data.threadId) throw Error('Message/event identity mismatch');
      if (await this.eligible(message)) {
        const key = replyKey(message.accountId, message.id, message.version);
        const tasks = Object.values(this.store.data.tasks);
        if (!tasks.some(task => (task.inputs ?? [task]).some(input => input.messageId === message.id))) {
          const now = observedAt;
          const visual = isVisualMessage(message);
          const deckRequest = !!this.config.snap && imageDeckRequest(message, this.config.ownUsername);
          const ref = { messageId: message.id, senderId: message.senderId, version: message.version, fingerprint: messageFingerprint(message), chars: inputChars(message), ...(visual ? { visual: true } : {}) };
          const batch = this.config.batchWindowMs > 0 && tasks.find(task => task.state === 'pending' && task.threadId === message.threadId
            && task.inputs && now - task.firstReceivedAt < this.config.batchMaxWaitMs
            && (!task.imageDeckSender || task.imageDeckSender === message.senderId)
            && (!deckRequest || task.inputs.every(ref => ref.senderId === message.senderId))
            && now - task.lastReceivedAt <= this.config.batchWindowMs && task.inputs.length < this.config.batchMaxMessages
            && task.inputs.filter(input => input.visual).length + Number(visual) <= 4
            && task.inputs.reduce((sum, input) => sum + input.chars, 0) + ref.chars <= 8000);
          const usage = groupUsage(this.store.data, message.threadId); usage.observedMessages++;
          if (batch) { batch.inputs.push(ref); batch.lastReceivedAt = now; if (deckRequest) batch.imageDeckSender = message.senderId; usage.mergedMessages++; }
          else this.store.data.tasks[key] = { key, messageId: message.id, version: message.version, threadId: message.threadId,
            state: 'pending', inputs: [ref], firstReceivedAt: now, lastReceivedAt: now, ...(deckRequest ? { imageDeckSender: message.senderId } : {}) };
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
      task.acceptedAt ??= this.now();
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
      if (!await this.eligible(current) || current.id !== ref.messageId || current.threadId !== task.threadId
        || (ref.fingerprint ? messageFingerprint(current) !== ref.fingerprint : current.version !== ref.version)) return null;
      messages.push(current);
    }
    if (task.deckImageSource) {
      const source = await this.client.message(this.config.accountId, task.deckImageSource.messageId);
      if (source.accountId !== this.config.accountId || source.threadId !== task.threadId || source.senderId !== task.deckImageSource.senderId || source.direction !== 'incoming' || source.recall || messageFingerprint(source) !== task.deckImageSource.fingerprint) return null;
    }
    return messages;
  }
  ignore(task) { task.state = 'ignored'; delete task.reply; this.store.save(); }
  async refreshContext(threadId) {
    try { await this.afterAnswer?.(threadId); }
    catch { this.report({ event: 'context.view-unavailable' }); }
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
    const now = this.now(); let generated = false;
    if (task.state === 'pending' && task.inputs && task.inputs.length < this.config.batchMaxMessages
      && now - task.lastReceivedAt < this.config.batchWindowMs && now - task.firstReceivedAt < this.config.batchMaxWaitMs) return;
    if (task.state === 'pending') { task.state = 'sealed'; this.store.save(); }
    const messages = await this.inputs(task);
    if (!messages?.length) { this.ignore(task); return; }
    const group = this.policy(messages[0]);
    const conversionRequest = this.config.snap && messages.find(message => imageDeckRequest(message, this.config.ownUsername));
    const replyRequired = !!conversionRequest || messages.some(message => this.assistantQuote(message));
    const observeOnly = !replyRequired && messages.every(message => describeMessage(message)?.kind === 'sticker');
    if (replyRequired) task.trigger = conversionRequest ? 'image-deck-request' : 'assistant-quote';
    if (task.state === 'sealed') {
      const usage = groupUsage(this.store.data, task.threadId);
      usage.callTimes = usage.callTimes.filter(at => at > now - 3600000);
      const reason = replyRequired ? null : this.config.maxCallsPerHour > 0 && usage.callTimes.length >= this.config.maxCallsPerHour ? 'hourly'
        : this.config.callIntervalMs > 0 && usage.lastCallAt !== null && now - usage.lastCallAt < this.config.callIntervalMs ? 'interval'
        : this.config.cooldownMs > 0 && now - (this.store.data.lastReply[task.threadId] ?? 0) < this.config.cooldownMs ? 'reply-cooldown' : null;
      if (reason) {
        task.state = 'rate-limited'; task.limitReason = reason;
        usage.rateLimitedBatches++; usage.rateLimitedMessages += messages.length;
        this.store.save(); this.report({ event: 'model.rate-limited', reason }); return;
      }
      // A persistent group thread already carries its previous turns. Only append
      // newly admitted batches; never replay the rolling WeChat window into it.
      const conversation = this.config.persistentConversations ? this.store.data.conversations[task.threadId] : null;
      if (conversation && conversation.profile !== this.codex.profile) throw Error('Group conversation profile mismatch');
      const page = this.config.persistentConversations ? { items: [] } : await this.client.messages(this.config.accountId, task.threadId, { limit: 12 });
      const ids = new Set(messages.map(message => message.id));
      const history = page.items.filter(item => item.accountId === this.config.accountId && item.threadId === task.threadId && item.type === 1 && !item.recall && !ids.has(item.id)
        && (item.direction === 'incoming' && group.senders.includes(item.senderId) || item.direction === 'outgoing' && item.senderId === this.config.ownUsername))
        .map(item => ({ sender: item.senderId, text: item.body?.slice(0, 2000), at: item.createdAt })).reverse();
      await this.identity();
      if (!await this.inputs(task)) { this.ignore(task); return; }
      const modelMessages = []; const imagePaths = [];
      let selectedImage;
      if (conversionRequest) {
        selectedImage = [...messages].reverse().find(message => message.senderId === conversionRequest.senderId && (describeMessage(message)?.kind === 'image' || message === conversionRequest && message.quote?.embeddedImage === true));
        if (!selectedImage) {
          const recent = await this.client.messages(this.config.accountId, task.threadId, {limit: 40});
          selectedImage = recent.items.filter(message => message.accountId === this.config.accountId && message.threadId === task.threadId && message.senderId === conversionRequest.senderId && message.direction === 'incoming' && message.type === 3 && !message.recall && Date.parse(message.createdAt) <= Date.parse(conversionRequest.createdAt) && Date.parse(conversionRequest.createdAt)-Date.parse(message.createdAt) <= 300000).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
        }
        if (selectedImage && !messages.some(message => message.id === selectedImage.id)) {
          task.deckImageSource = {messageId:selectedImage.id,senderId:selectedImage.senderId,fingerprint:messageFingerprint(selectedImage)};
          this.store.save();
        }
      }
      let deckImageIndex;
      const suppliedMessages = selectedImage && !messages.some(message => message.id === selectedImage.id) ? [...messages,selectedImage] : messages;
      for (const message of suppliedMessages) {
        const content = describeMessage(message);
        const input = { sender: message.senderId, text: content.text, at: message.createdAt,
          ...(content.kind !== 'text' ? { kind: content.kind } : {}), ...(quotedInput(message) ? { quote: quotedInput(message) } : {}) };
        if (isVisualMessage(message) && group.receiveImagesAndStickers === true) {
          const visual = await prepareVisual({ client: this.client, config: this.config, message, signal: this.signal,
            assertCurrent: async () => { await this.identity(); if (!await this.inputs(task)) throw Object.assign(Error('Visual source changed'), { code: 'VISUAL_INTEGRITY' }); } });
          input.vision = { status: visual.status, ...(visual.status === 'ready' ? {
            imageIndex: imagePaths.length + 1, width: visual.width, height: visual.height, representation: visual.representation,
          } : {}) };
          if (visual.status === 'ready') { imagePaths.push(visual.path); if (message.id === selectedImage?.id) deckImageIndex = imagePaths.length; }
        } else if (isVisualMessage(message)) {
          input.vision = { status: 'disabled' };
        }
        modelMessages.push(input);
      }
      if (messages.some(message => isVisualMessage(message))) {
        await this.identity();
        if (!await this.inputs(task)) { this.ignore(task); return; }
      }
      // Reserve one call and its whole batch before any model request can leave.
      task.state = 'generating'; usage.callsStarted++; usage.lastCallAt = this.now(); usage.callTimes.push(usage.lastCallAt);
      task.modelStartedAt = usage.lastCallAt;
      this.store.save();
      const scope = {accountId:this.config.accountId,groupId:task.threadId,messages:messages.map(message=>({id:message.id,sender:message.senderId,text:message.body??""}))};
      let decision;
      try {
        decision = await this.codex.answer({ history, messages: modelMessages, mode: group.mode, ...(replyRequired ? { replyRequired: true } : {}), ...(observeOnly ? { observeOnly: true } : {}), ...(conversionRequest ? {deckImageRequest:{authorized:!!deckImageIndex,imageIndex:deckImageIndex??null,sender:conversionRequest.senderId,requestMessageId:conversionRequest.id,sourceMessageId:selectedImage?.id??null}} : {}) }, this.config.persistentConversations ? {
          imagePaths, scope,
          persist: true, conversation, title: `微信群助手 · ${task.threadId}`,
          onThread: info => {
            const existing = this.store.data.conversations[task.threadId];
            if (existing && (existing.threadId !== info.threadId || existing.profile !== info.profile)) throw Error('Group conversation identity changed');
            if (Object.entries(this.store.data.conversations).some(([groupId, other]) => groupId !== task.threadId && other.threadId === info.threadId && other.profile === info.profile)) throw Error('Conversation is already assigned to another group');
            this.store.data.conversations[task.threadId] = { ...info, seenMessageIds: [...new Set([...(existing?.seenMessageIds ?? []), ...messages.map(message => message.id)])].slice(-2000) };
            this.store.save();
          },
        } : { imagePaths, scope });
        task.modelCompletedAt = this.now();
        if (typeof decision?.reply !== 'boolean' || decision.reply && (typeof decision.text !== 'string' || !decision.text.trim() || decision.text.length > (decision.enginePreview ? 10000 : decision.verifiedDeckCode ? 6000 : 1600))) throw Object.assign(Error('Invalid bounded reply'), { usage: decision?.usage });
      } catch (error) {
        task.modelCompletedAt = this.now();
        recordResult(this.store.data, task, error.usage, 'failed'); task.state = 'generation-failed'; this.store.save();
        this.report({ event: 'model.failed' }); throw error;
      }
      recordResult(this.store.data, task, decision.usage, 'completed');
      task.modelRequests = decision.modelRequests ?? 1;
      if (decision.engineOperations?.length) task.engineOperations = decision.engineOperations;
      if (decision.verifiedDeckCode) task.verifiedDeckCode = true;
      generated = true;
      if (observeOnly) {
        task.silenceReason = 'sticker-only';
        task.replySuppressed = decision.reply;
        decision = { ...decision, reply: false };
      }
      if (replyRequired && !decision.reply) {
        decision = { ...decision, reply: true, text: conversionRequest ? '请先发清晰的卡组图片，再原生@我请求转码；也可以引用原图并@我。看不清的卡牌请补充卡名。' : '我看到了你引用的消息。你希望我解释或补充哪一部分？' };
        task.replyFallback = true;
      }
      if (!decision.reply) { usage.silentCalls++; this.ignore(task); await this.refreshContext(task.threadId); return; }
      task.reply = decision.text.trim(); task.state = 'prepared'; this.store.save();
    }
    // Also cover a prepared sticker reply left by an earlier worker version.
    if (observeOnly) { task.silenceReason = 'sticker-only'; this.ignore(task); return; }
    if (!this.config.sendEnabled) { task.state = 'dry-run'; delete task.reply; this.store.save(); this.report({ event: 'reply.dry-run' }); if (generated) await this.refreshContext(task.threadId); return; }
    await this.identity();
    const recheck = await this.inputs(task);
    this.signal?.throwIfAborted();
    if (!recheck) { this.ignore(task); return; }
    task.state = 'submitting'; task.sendStartedAt ??= this.now(); this.store.save();
    try { await this.settle(task, await this.client.sendText(this.config.accountId, task.threadId, task.reply, task.key)); }
    catch { task.state = 'unknown'; this.store.save(); this.report({ event: 'reply.unknown' }); }
    // Derive the optional view after saving generation and send state. A viewer
    // failure must not delay sending or grant another model call.
    if (generated) await this.refreshContext(task.threadId);
  }
}

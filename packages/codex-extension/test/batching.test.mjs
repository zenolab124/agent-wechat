import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, validateConfig } from '../src/bridge.mjs';
import { StateStore } from '../src/state.mjs';
import { CodexClient } from '../src/codex.mjs';
import { groupUsage, tokenUsage, usageSnapshot } from '../src/usage.mjs';

const sample = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, cacheWriteInputTokens: 0, totalTokens: 120 };

function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wx-codex-batch-'));
  const config = { baseUrl: 'http://127.0.0.1:16174', accountId: 'account', ownUsername: 'bot', sendEnabled: true,
    groups: [{ id: 'a@chatroom', senders: ['one', 'two'], mode: 'selective' }, { id: 'b@chatroom', senders: ['one'], mode: 'selective' }], ...options };
  const binding = { baseUrl: config.baseUrl, accountId: config.accountId, ownUsername: config.ownUsername };
  let store = new StateStore(directory, binding), now = Date.now() + 1000, cursor = 0;
  const rows = new Map(), generations = [], sends = [];
  const client = {
    account: async () => ({ id: 'account', ownUsername: 'bot', authenticated: true }),
    message: async (_account, id) => structuredClone(rows.get(id)),
    messages: async () => ({ items: [] }),
    sendText: async (accountId, destination, text, key) => { const intent = { id: `send-${sends.length}`, accountId, destination, state: 'accepted' }; sends.push({ key, text, ...intent }); return intent; },
    sendByKey: async (_account, key) => sends.find(send => send.key === key),
    send: async (_account, id) => sends.find(send => send.id === id),
  };
  const codex = { answer: async context => { generations.push(structuredClone(context)); return { reply: true, text: 'one reply', usage: sample }; } };
  const create = () => new Bridge({ client, codex, store, config, now: () => now });
  let bridge = create();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    config, rows, client, codex, generations, sends, directory, binding,
    get bridge() { return bridge; }, get data() { return store.data; }, get now() { return now; }, advance(ms) { now += ms; },
    restart() { store.close(); store = new StateStore(directory, binding); bridge = create(); },
    save() { store.save(); },
    async add(id, { group = 'a@chatroom', sender = 'one', text = id, createdAt = new Date(now).toISOString() } = {}) {
      rows.set(id, { id, accountId: 'account', threadId: group, senderId: sender, type: 1, direction: 'incoming', body: text, version: 'profile-1', createdAt });
      await bridge.accept({ cursor: String(++cursor), kind: 'message.committed', data: { messageId: id, threadId: group, origin: 'live' } });
    },
  };
}

test('same-group burst waits for silence and invokes Codex once with ordered messages from admitted senders', async t => {
  const f = harness(t);
  await f.add('first'); await f.bridge.drain(); assert.equal(f.generations.length, 0);
  f.advance(2000); await f.add('second', { sender: 'two' });
  f.advance(2000); await f.bridge.drain(); assert.equal(f.generations.length, 0);
  f.advance(1000); await f.bridge.drain();
  assert.equal(f.generations.length, 1); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.generations[0].messages.map(m => [m.sender, m.text]), [['one', 'first'], ['two', 'second']]);
  assert.equal(f.data.usage.groups['a@chatroom'].callsStarted, 1); assert.equal(f.data.usage.groups['a@chatroom'].mergedMessages, 1);
  assert.ok(!readFileSync(join(f.directory, 'state.json'), 'utf8').includes('"body"'));
});

test('continuous traffic is bounded by maximum wait and maximum messages', async t => {
  const f = harness(t);
  for (let n = 0; n < 6; n++) { await f.add(`message-${n}`); await f.bridge.drain(); if(n < 5) f.advance(2000); }
  assert.equal(f.generations.length, 1); assert.equal(f.generations[0].messages.length, 5);
  assert.equal(Object.values(f.data.tasks).filter(task => task.state === 'pending').length, 1);
  const g = harness(t, { batchMaxMessages: 2 }); await g.add('one'); await g.add('two'); await g.bridge.drain();
  assert.equal(g.generations.length, 1);
});

test('a batch cannot exceed its 8000-character input bound', async t => {
  const f = harness(t); await f.add('first', { text: 'a'.repeat(4000) }); await f.add('second', { text: 'b'.repeat(4000) }); await f.add('third', { text: 'c' });
  assert.equal(Object.keys(f.data.tasks).length, 2); f.advance(3000); await f.bridge.drain();
  assert.equal(f.generations.length, 1); assert.equal(f.generations[0].messages.reduce((sum, m) => sum + m.text.length, 0), 8000);
});

test('different groups keep independent batches and call quotas', async t => {
  const f = harness(t, { maxCallsPerHour: 1 }); await f.add('a'); await f.add('b', { group: 'b@chatroom' }); f.advance(3000); await f.bridge.drain();
  assert.equal(f.generations.length, 2); assert.equal(f.sends.length, 2);
  assert.equal(f.data.usage.groups['a@chatroom'].callsStarted, 1); assert.equal(f.data.usage.groups['b@chatroom'].callsStarted, 1);
  assert.deepEqual(f.generations.map(c => c.messages.length), [1, 1]);
});

test('silence consumes quota and preflight rate limits run before history or model calls', async t => {
  const f = harness(t); f.codex.answer = async context => { f.generations.push(context); return { reply: false, usage: sample }; };
  await f.add('first'); f.advance(3000); await f.bridge.drain();
  f.client.messages = async () => { throw Error('rate-limited input must not read history'); };
  await f.add('second'); f.advance(3000); await f.bridge.drain();
  const usage = f.data.usage.groups['a@chatroom']; assert.equal(f.generations.length, 1); assert.equal(f.sends.length, 0);
  assert.equal(usage.silentCalls, 1); assert.equal(usage.rateLimitedBatches, 1); assert.equal(usage.tokens.totalTokens, 120);
});

test('rolling hourly quota survives restart, does not queue late replies, and expires at the boundary', async t => {
  const f = harness(t, { maxCallsPerHour: 2 });
  await f.add('one'); f.advance(3000); await f.bridge.drain();
  f.advance(30000); await f.add('two'); f.advance(3000); await f.bridge.drain(); f.restart();
  f.advance(30000); await f.add('three'); f.advance(3000); await f.bridge.drain();
  assert.equal(f.generations.length, 2); assert.equal(Object.values(f.data.tasks).at(-1).limitReason, 'hourly');
  f.advance(3600000); await f.bridge.drain(); assert.equal(f.generations.length, 2);
  await f.add('four'); f.advance(3000); await f.bridge.drain(); assert.equal(f.generations.length, 3);
});

test('pending batch survives restart and original source policy is checked again', async t => {
  const f = harness(t); await f.add('first'); f.advance(1000); await f.add('second'); f.restart(); f.advance(3000); await f.bridge.drain();
  assert.equal(f.generations.length, 1); assert.equal(f.generations[0].messages.length, 2);
  const g = harness(t); await g.add('first'); await g.add('second'); g.rows.get('second').recall = {}; g.advance(3000); await g.bridge.drain();
  assert.equal(g.generations.length, 0); assert.equal(g.sends.length, 0);
});

test('unrelated profile generation changes do not invalidate unchanged batch content', async t => {
  const f = harness(t); await f.add('one'); f.rows.get('one').version = 'profile-2'; f.advance(3000); await f.bridge.drain();
  assert.equal(f.sends.length, 1);
});

test('unknown batch submission is recovered without another POST or model call', async t => {
  const f = harness(t); const submit = f.client.sendText;
  f.client.sendText = async (...args) => { await submit(...args); throw Error('response lost'); };
  await f.add('one'); await f.add('two'); f.advance(3000); await f.bridge.drain(); assert.equal(Object.values(f.data.tasks)[0].state, 'unknown');
  f.restart(); await f.bridge.drain();
  assert.equal(f.sends.length, 1); assert.equal(f.generations.length, 1); assert.equal(Object.values(f.data.tasks)[0].state, 'done');
  assert.equal(f.data.usage.groups['a@chatroom'].tokens.totalTokens, 120); assert.equal(f.data.usage.groups['a@chatroom'].repliesAccepted, 1);
});

test('failed and interrupted inference consume one quota reservation; missing usage is not zero usage', async t => {
  const f = harness(t); f.codex.answer = async context => { f.generations.push(context); throw Object.assign(Error('provider failed'), { usage: sample }); };
  await f.add('one'); f.advance(3000); await assert.rejects(f.bridge.drain()); f.restart(); await f.bridge.drain();
  assert.equal(f.generations.length, 1); assert.equal(f.data.usage.groups['a@chatroom'].failedCalls, 1); assert.equal(f.data.usage.groups['a@chatroom'].tokens.totalTokens, 120);
  const g = harness(t); await g.add('one'); const task = Object.values(g.data.tasks)[0]; task.state = 'generating';
  const usage = groupUsage(g.data, task.threadId); usage.callsStarted++; usage.lastCallAt = g.now; usage.callTimes.push(g.now); g.save();
  g.restart(); await g.bridge.drain(); assert.equal(g.generations.length, 0); assert.equal(g.data.usage.groups['a@chatroom'].unknownCalls, 1);
  assert.equal(g.data.usage.groups['a@chatroom'].unreportedCalls, 1);
  const h = harness(t); h.codex.answer = async () => ({ reply: false }); await h.add('one'); h.advance(3000); await h.bridge.drain();
  assert.equal(h.data.usage.groups['a@chatroom'].reportedCalls, 0); assert.equal(h.data.usage.groups['a@chatroom'].unreportedCalls, 1);
});

test('usage notifications are snapshots, not deltas; model JSON cannot forge usage', async () => {
  const client = new CodexClient();
  const result = new Promise((resolve, reject) => client.turns.set('thread', { resolve, reject, timer: setTimeout(() => {}, 10000), text: '', turnId: 'turn' }));
  const usage = total => client.onMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId: 'turn', tokenUsage: { total } } });
  client.onMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId: 'another', tokenUsage: { total: { ...sample, totalTokens: 9999 } } } });
  usage(sample); usage(sample); usage({ ...sample, totalTokens: 119 }); usage({ totalTokens: -1 });
  client.onMessage({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'final_answer', text: '{"reply":false,"usage":{"totalTokens":999999}}' } } });
  client.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
  assert.deepEqual((await result).usage, sample);
  assert.equal(tokenUsage({ ...sample, cachedInputTokens: 101 }), null);
});

test('v1 upgrade keeps send recovery intact and does not invent historical token statistics', t => {
  const f = harness(t); const p = join(f.directory, 'state.json'); const old = JSON.parse(readFileSync(p));
  old.schema = 1; delete old.usage; old.tasks.legacy = { key: 'legacy', messageId: 'old', version: '1', threadId: 'a@chatroom', state: 'unknown' };
  writeFileSync(p, JSON.stringify(old)); f.restart();
  assert.equal(f.data.schema, 2); assert.equal(f.data.tasks.legacy.state, 'unknown'); assert.deepEqual(usageSnapshot(f.data).groups, []);
});

test('invalid rate and batching configuration is rejected rather than disabling controls', t => {
  const f = harness(t);
  for (const patch of [{ maxCallsPerHour: 0 }, { callIntervalMs: -1 }, { batchWindowMs: Infinity }, { batchWindowMs: 4000, batchMaxWaitMs: 3000 }, { batchMaxMessages: 0 }]) assert.throws(() => validateConfig({ ...f.config, ...patch }));
});

test('corrupted quota state is rejected instead of silently resetting usage', t => {
  const f = harness(t); const usage = groupUsage(f.data, 'a@chatroom'); usage.completedCalls = 1; f.save();
  assert.throws(() => f.restart(), /Inconsistent usage journal/);
});

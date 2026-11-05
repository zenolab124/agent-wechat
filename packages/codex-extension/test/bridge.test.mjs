import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, validateConfig, replyKey } from '../src/bridge.mjs';
import { StateStore } from '../src/state.mjs';
import { CodexClient, workerArgs } from '../src/codex.mjs';
import { verifyAssistantQuote } from '../src/quotes.mjs';

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wx-codex-test-'));
  const config = { baseUrl: 'http://127.0.0.1:16174', accountId: 'account-test', ownUsername: 'bot', sendEnabled: true, cooldownMs: 1000, batchWindowMs: 0, batchMaxWaitMs: 0, callIntervalMs: 1000,
    groups: [{ id: 'test@chatroom', senders: ['human'], mode: 'prefix', prefix: '/助手' }], ...overrides };
  const binding = { baseUrl: config.baseUrl, accountId: config.accountId, ownUsername: config.ownUsername };
  const store = new StateStore(directory, binding);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const message = { id: 'message-1', accountId: 'account-test', threadId: 'test@chatroom', senderId: 'human', type: 1, direction: 'incoming',
    body: '/助手 请回复接通成功', createdAt: new Date().toISOString(), version: '1' };
  const calls = []; const generations = [];
  const receipt = { id: 'send-1', accountId: 'account-test', destination: 'test@chatroom', state: 'accepted' };
  const client = {
    account: async () => ({ id: config.accountId, authenticated: true, ownUsername: 'bot' }),
    message: async () => message,
    messages: async () => ({ items: [] }),
    sendText: async (...args) => { calls.push(args); return receipt; },
    sendByKey: async () => receipt,
    send: async () => receipt,
  };
  const codex = { answer: async context => { generations.push(context); return { reply: true, text: '接通成功' }; } };
  const bridge = new Bridge({ client, codex, store, config });
  const event = (cursor = '1', origin = 'live') => ({ cursor, kind: 'message.committed', data: { messageId: message.id, threadId: message.threadId, origin } });
  return { bridge, client, codex, store, message, calls, generations, event, config, receipt, directory, binding };
}

test('live group message generates one accepted reply; duplicate cursor and later duplicate observation do not send twice', async t => {
  const f = fixture(t);
  await f.bridge.accept(f.event()); await f.bridge.drain();
  await f.bridge.accept(f.event()); await f.bridge.accept(f.event('2')); await f.bridge.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.generations.length, 1);
  assert.equal(Object.values(f.store.data.tasks)[0].state, 'done');
  assert.equal(f.calls[0][3], replyKey(f.config.accountId, f.message.id, f.message.version));
  assert.ok(!readFileSync(join(f.directory, 'state.json'), 'utf8').includes('接通成功'));
});

test('catchup/import/unknown observations do not wake Codex', async t => {
  for (const origin of ['catchup', 'import', 'unknown']) {
    const f = fixture(t); await f.bridge.accept(f.event('1', origin)); await f.bridge.drain();
    assert.equal(f.generations.length, 0); assert.equal(f.store.data.cursor, '1');
  }
});

test('wrong group, sender, outgoing, system, recalled, missing/old timestamps and missing prefix are ignored', async t => {
  for (const mutation of [{ threadId: 'other@chatroom' }, { senderId: 'outsider' }, { senderId: 'bot' }, { direction: 'outgoing' }, { type: 10000 },
    { recall: { replacementText: 'recalled' } }, { createdAt: null }, { createdAt: 'bad' }, { createdAt: '2020-01-01T00:00:00Z' }, { body: '普通聊天' }]) {
    const f = fixture(t); Object.assign(f.message, mutation);
    await f.bridge.accept(f.event()); await f.bridge.drain(); assert.equal(f.calls.length, 0); assert.equal(f.generations.length, 0);
  }
});

test('selective mode admits a message without @ and supports silence', async t => {
  const f = fixture(t, { groups: [{ id: 'test@chatroom', senders: ['human'], mode: 'selective' }] });
  f.message.body = '这个群助手现在接通了吗？'; f.codex.answer = async context => { f.generations.push(context); return { reply: false }; };
  await f.bridge.accept(f.event()); await f.bridge.drain();
  assert.equal(f.generations.length, 1); assert.equal(f.calls.length, 0);
});

test('dry-run never sends or later replays its answer when send mode changes', async t => {
  const f = fixture(t, { sendEnabled: false }); await f.bridge.accept(f.event()); await f.bridge.drain();
  f.bridge.config.sendEnabled = true; await f.bridge.drain();
  assert.equal(f.calls.length, 0); assert.equal(f.generations.length, 1);
});

test('account switch stops before model execution or sending', async t => {
  const f = fixture(t); await f.bridge.accept(f.event());
  f.client.account = async () => ({ id: f.config.accountId, authenticated: true, ownUsername: 'another-account' });
  await assert.rejects(f.bridge.drain(), /identity changed/);
  assert.equal(f.calls.length, 0); assert.equal(f.generations.length, 0);
});

test('message recalled during generation is not sent', async t => {
  const f = fixture(t); f.codex.answer = async () => { f.message.recall = {}; return { reply: true, text: 'answer' }; };
  await f.bridge.accept(f.event()); await f.bridge.drain(); assert.equal(f.calls.length, 0);
});

test('stopping the worker during generation prevents a subsequent send', async t => {
  const f = fixture(t); const controller = new AbortController(); f.bridge.signal = controller.signal;
  f.codex.answer = async () => { controller.abort(); return { reply: true, text: 'must not send after stop' }; };
  await f.bridge.accept(f.event()); await assert.rejects(f.bridge.drain(), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});

test('unknown POST survives restart and missing lookup never causes a second POST or regeneration', async t => {
  const f = fixture(t); f.client.sendText = async (...args) => { f.calls.push(args); throw Error('connection reset after remote acceptance'); };
  f.client.sendByKey = async () => { throw Error('not found'); };
  await f.bridge.accept(f.event()); await f.bridge.drain();
  f.store.close(); const restarted = new StateStore(f.directory, f.binding);
  const bridge = new Bridge({ client: f.client, codex: f.codex, store: restarted, config: f.config });
  await bridge.drain(); assert.equal(f.calls.length, 1); assert.equal(f.generations.length, 1);
  assert.equal(Object.values(restarted.data.tasks)[0].state, 'unknown');
  f.client.sendByKey = async () => f.receipt;
  await bridge.drain(); assert.equal(Object.values(restarted.data.tasks)[0].state, 'done'); assert.equal(f.calls.length, 1);
  restarted.close();
});

test('prepared reply resumes without another model call after restart', async t => {
  const f = fixture(t); await f.bridge.accept(f.event());
  const task = Object.values(f.store.data.tasks)[0]; task.state = 'prepared'; task.reply = 'prepared answer'; f.store.save();
  await f.bridge.drain(); assert.equal(f.generations.length, 0); assert.equal(f.calls[0][2], 'prepared answer');
});

test('a pending native receipt blocks following messages in that group', async t => {
  const f = fixture(t); f.receipt.state = 'submitting';
  await f.bridge.accept(f.event()); await f.bridge.drain();
  f.message.id = 'message-2'; await f.bridge.accept(f.event('2')); await f.bridge.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.generations.length, 1);
});

test('events outside admitted groups do not read message bodies', async t => {
  const f = fixture(t); let reads = 0; f.client.message = async () => { reads++; throw Error('must not read this group'); };
  const event = f.event(); event.data.threadId = 'other@chatroom';
  await f.bridge.accept(event); assert.equal(reads, 0); assert.equal(f.store.data.cursor, '1');
});

test('event/message identity mismatch retains cursor', async t => {
  const f = fixture(t); const event = f.event(); f.message.threadId = 'other@chatroom';
  await assert.rejects(f.bridge.accept(event), /identity mismatch/); assert.equal(f.store.data.cursor, '0');
});

test('failed native receipt does not retry; receipt identity cannot complete another destination', async t => {
  const f = fixture(t); f.receipt.state = 'failed'; await f.bridge.accept(f.event()); await f.bridge.drain(); await f.bridge.drain();
  assert.equal(f.calls.length, 1); assert.equal(Object.values(f.store.data.tasks)[0].state, 'failed');
  const g = fixture(t); g.receipt.destination = 'other@chatroom'; await g.bridge.accept(g.event()); await g.bridge.drain();
  assert.equal(Object.values(g.store.data.tasks)[0].state, 'unknown');
});

test('worker lock prevents a second owner; corrupt state and different account are never reset', t => {
  const f = fixture(t); assert.throws(() => new StateStore(f.directory, f.binding), /EEXIST/);
  f.store.close(); assert.throws(() => new StateStore(f.directory, { ...f.binding, ownUsername: 'changed' }), /binding/);
  writeFileSync(join(f.directory, 'state.json'), 'broken'); assert.throws(() => new StateStore(f.directory, f.binding), SyntaxError);
});

test('remote URLs, wildcard sender and ambiguous group policies are rejected', t => {
  const f = fixture(t);
  for (const mutation of [{ baseUrl: 'http://example.com' }, { groups: [] }, { groups: [{ id: 'test@chatroom', senders: ['*'], mode: 'selective' }] }, { sendEnabled: 'true' }]) assert.throws(() => validateConfig({ ...f.config, ...mutation }));
  const bootstrap = { baseUrl: f.config.baseUrl, accountId: f.config.accountId, groups: [] };
  assert.doesNotThrow(() => validateConfig(bootstrap, { bootstrap: true }));
  assert.throws(() => validateConfig(bootstrap));
});

test('Codex only accepts completed final JSON and denies tool requests', async () => {
  const client = new CodexClient(); const writes = []; client.write = value => writes.push(value);
  client.onMessage({ id: 3, method: 'item/commandExecution/requestApproval', params: {} }); assert.equal(writes[0].error.code, -32601);
  const final = new Promise((resolve, reject) => client.turns.set('thread', { resolve, reject, timer: setTimeout(() => {}, 10000), text: '' }));
  client.onMessage({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'commentary', text: 'private reasoning' } } });
  client.onMessage({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'final_answer', text: '{"reply":true,"text":"final"}' } } });
  client.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
  assert.deepEqual(await final, { reply: true, text: 'final', usage: null });
  const args = workerArgs(['private-server']); assert.ok(args.includes('mcp_servers.private-server.enabled=false'));
  assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('features.apps=false'));
});

test('Codex account preflight retries only a bounded read timeout, never auth rejection', async () => {
  const client = new CodexClient(); let calls = 0;
  client.request = async () => { calls++; if(calls < 3) throw Object.assign(Error('timeout'), { accountReadTimeout: true }); return { account: { type: 'chatgpt' } }; };
  assert.deepEqual(await client.readAccount(), { account: { type: 'chatgpt' } }); assert.equal(calls, 3);
  calls = 0; client.request = async () => { calls++; throw Object.assign(Error('still timed out'), { accountReadTimeout: true }); };
  await assert.rejects(client.readAccount()); assert.equal(calls, 3);
  calls = 0; client.request = async () => { calls++; throw Error('auth rejected'); };
  await assert.rejects(client.readAccount(), /auth rejected/); assert.equal(calls, 1);
});

test('RPC diagnostics expose the failing method without copying private server error text', async () => {
  const client = new CodexClient(); client.write = () => {}; client.child = { exitCode: null, killed: false };
  const rejected = client.request('account/read', { refreshToken: false });
  client.onMessage({ id: 1, error: { code: -32603, message: 'Private host timed out' } });
  await assert.rejects(rejected, error => error.accountReadTimeout === true && error.code === 'CODEX_ACCOUNT_READ_TIMEOUT' && !error.message.includes('Private host'));
});

function quoteFixture(t, groupPatch = {}) {
  const f = fixture(t, { groups: [{ id: 'test@chatroom', senders: ['human'], mode: 'prefix', prefix: '/助手', replyToAssistantQuotes: true, ...groupPatch }] });
  const original = { id: 'source', accountId: f.config.accountId, threadId: 'test@chatroom', serverId: '20', senderId: 'bot', direction: 'outgoing', type: 1, body: 'stored original must not replace the excerpt' };
  f.client.messages = async (_account, _thread, options) => ({ items: options.limit === 200 ? [original] : [] });
  Object.assign(f.message, { type: 49, appMessageType: 57, body: '哈哈', senderId: 'another-member',
    quote: { serverId: '20', senderId: 'bot', direction: 'outgoing', state: 'embedded', type: 1, embeddedText: 'quoted excerpt' } });
  return { ...f, original };
}

test('any member in an enabled group can quote the assistant without a prefix, carrying the exact embedded excerpt', async t => {
  const f = quoteFixture(t); await f.bridge.accept(f.event()); await f.bridge.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.generations[0].replyRequired, true);
  assert.equal(f.generations[0].messages[0].quote.text, 'quoted excerpt');
  assert.ok(!JSON.stringify(f.generations).includes(f.original.body));
  assert.equal(Object.values(f.store.data.tasks)[0].trigger, 'assistant-quote');
  await f.bridge.accept(f.event('2')); await f.bridge.drain(); assert.equal(f.calls.length, 1);
});

test('mandatory quote bypasses normal hourly/interval/cooldown gates and a silent model decision gets a clarification reply', async t => {
  const f = quoteFixture(t); f.bridge.config.maxCallsPerHour = 1;
  const quote = structuredClone(f.message);
  Object.assign(f.message, { id: 'ordinary', type: 1, appMessageType: undefined, quote: undefined, senderId: 'human', body: '/助手 first' });
  await f.bridge.accept(f.event()); await f.bridge.drain();
  Object.assign(f.message, quote, { id: 'quote-followup' });
  f.codex.answer = async context => { f.generations.push(context); return { reply: false }; };
  await f.bridge.accept(f.event('2')); await f.bridge.drain();
  assert.equal(f.calls.length, 2); assert.equal(f.generations.length, 2);
  assert.match(f.calls[1][2], /你引用的消息/);
  assert.equal(Object.values(f.store.data.tasks).at(-1).replyFallback, true);
  assert.equal(f.store.data.usage.groups['test@chatroom'].rateLimitedBatches, 0);
});

test('quote opt-out, other authors, fake source identities, recall and unsupported subtype cannot open the mandatory route', async t => {
  for (const mutate of [f => { f.bridge.config.groups[0].replyToAssistantQuotes = false; },
    f => { f.message.quote.senderId = 'someone-else'; }, f => { f.original.senderId = 'someone-else'; },
    f => { f.original.accountId = 'other'; }, f => { f.original.threadId = 'other@chatroom'; },
    f => { f.original.recall = {}; }, f => { f.message.quote.state = 'recalled'; },
    f => { f.message.appMessageType = 5; }, f => { f.message.quote.serverId = '0'; },
    f => { Object.assign(f.message, { type: 1, quote: null, body: 'a concrete question?' }); }]) {
    const f = quoteFixture(t); mutate(f); await f.bridge.accept(f.event()); await f.bridge.drain();
    assert.equal(f.generations.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('verified quote-only messages still trigger a reply when the comment is empty', async t => {
  const f = quoteFixture(t); f.message.body = '';
  await f.bridge.accept(f.event()); await f.bridge.drain(); assert.equal(f.calls.length, 1);
  assert.equal(f.generations[0].replyRequired, true); assert.equal(f.generations[0].messages[0].text, '');
});

test('a changed quote excerpt or recalled original during inference prevents sending the stale answer', async t => {
  for (const mutate of [f => { f.message.quote.embeddedText = 'changed'; }, f => { f.original.recall = {}; }]) {
    const f = quoteFixture(t); f.codex.answer = async () => { mutate(f); return { reply: true, text: 'stale' }; };
    await f.bridge.accept(f.event()); await f.bridge.drain(); assert.equal(f.calls.length, 0);
  }
});

test('quote identity lookup paginates without substituting source content and stops on a repeated cursor', async t => {
  const f = quoteFixture(t); let reads = 0;
  f.client.messages = async (_account, _thread, options) => { reads++; return options.cursor ? { items: [f.original], nextCursor: null } : { items: [], nextCursor: 'next' }; };
  assert.equal(await verifyAssistantQuote(f.client, f.config, f.message), true); assert.equal(reads, 2);
  f.client.messages = async () => ({ items: [], nextCursor: 'same' });
  assert.equal(await verifyAssistantQuote(f.client, f.config, f.message), false);
});

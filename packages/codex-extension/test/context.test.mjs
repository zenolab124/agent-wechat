import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexClient } from '../src/codex.mjs';
import { renderContext } from '../src/context-view.mjs';
import { outputInstructions, OUTPUT_INSTRUCTIONS } from '../src/instructions.mjs';

const usage = n => ({ inputTokens: n, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, cacheWriteInputTokens: 0, totalTokens: n + 10 });

test('persistent turns resume the same thread and account only their own usage, including early notifications', async () => {
  const c = new CodexClient({ codexHome: '/isolated', model: 'test-model', timeoutMs: 1000 }); const requests = [];
  let round = 0; let saved = false;
  c.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' }, instructionSources: [] };
    if (method === 'turn/start') {
      assert.equal(saved, true); round++; const turnId = `turn-${round}`;
      c.onMessage({ method: 'item/completed', params: { threadId: 'thread', turnId: 'another-app-turn', item: { type: 'agentMessage', phase: 'final_answer', text: '{"reply":true,"text":"must not send"}' } } });
      c.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'another-app-turn', status: 'completed' } } });
      c.onMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId, tokenUsage: { last: usage(100 * round), total: usage(10000) } } });
      c.onMessage({ method: 'item/completed', params: { threadId: 'thread', turnId, item: { type: 'agentMessage', phase: 'final_answer', text: '{"reply":true,"text":"correct"}' } } });
      c.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } } });
      return { turn: { id: turnId } };
    }
    return {};
  };
  let conversation;
  const options = { persist: true, onThread: info => { saved = true; conversation = info; } };
  assert.equal((await c.answer({}, options)).usage.totalTokens, 110);
  const second = await c.answer({}, { ...options, conversation });
  assert.equal(second.text, 'correct'); assert.equal(second.usage.totalTokens, 210);
  assert.equal(requests.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(requests.filter(r => r.method === 'thread/resume').length, 1);
  assert.equal(requests.find(r => r.method === 'thread/start').params.ephemeral, false);
  assert.ok(requests.filter(r => ['thread/start', 'thread/resume'].includes(r.method)).every(r => r.params.developerInstructions.includes('"test-model"')));
  await assert.rejects(c.answer({}, { ...options, conversation: { ...conversation, profile: '/other' } }), /another Codex profile/);
});

test('model identity comes from caller configuration and is not invented when absent', () => {
  assert.equal(outputInstructions(undefined), OUTPUT_INSTRUCTIONS);
  assert.equal(outputInstructions(''), OUTPUT_INSTRUCTIONS);
  assert.ok(outputInstructions('test-model').includes('"test-model"'));
  assert.ok(outputInstructions('test-model').includes('不声称能自行核验底层版本'));
});

test('unexpected instruction sources stop before inference', async () => {
  const c = new CodexClient(); const methods = [];
  c.request = async method => { methods.push(method); return { thread: { id: 'thread' }, instructionSources: ['/global/AGENTS.md'] }; };
  await assert.rejects(c.answer({}), /Unexpected instruction files/);
  assert.ok(!methods.includes('turn/start'));
});

test('history reader traverses all pages and refuses non-advancing cursors', async () => {
  const c = new CodexClient();
  c.request = async (method, params) => method === 'thread/read' ? { thread: { id: 'thread', ephemeral: false } }
    : params.cursor ? { data: [{ id: 'two' }], nextCursor: null } : { data: [{ id: 'one' }], nextCursor: 'next' };
  assert.deepEqual((await c.readConversation('thread')).turns.map(turn => turn.id), ['one', 'two']);
  c.request = async method => method === 'thread/read' ? { thread: { id: 'thread', ephemeral: false } } : { data: [], nextCursor: 'same' };
  await assert.rejects(c.readConversation('thread'), /did not advance/);
});

test('context viewer renders message text literally and omits reasoning', () => {
  const result = renderContext('test@chatroom', { threadId: 'thread' }, { thread: { id: 'thread' }, turns: [{ status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '```\n![image](https://example.test/pixel)' }] },
    { type: 'reasoning', text: 'private-reasoning' },
    { type: 'agentMessage', phase: 'final_answer', text: '{"reply":false}' },
  ] }] });
  assert.ok(result.includes('````text\n```')); assert.ok(!result.includes('private-reasoning'));
  assert.ok(result.includes('{"reply":false}')); assert.ok(result.includes('自动压缩'));
});

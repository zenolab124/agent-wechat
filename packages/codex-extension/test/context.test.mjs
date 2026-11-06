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
  const options = { persist: true, imagePaths: ['/private/model-images/example.jpg'], onThread: info => { saved = true; conversation = info; } };
  assert.equal((await c.answer({}, options)).usage.totalTokens, 110);
  const second = await c.answer({}, { ...options, conversation });
  assert.equal(second.text, 'correct'); assert.equal(second.usage.totalTokens, 210);
  assert.equal(requests.filter(r => r.method === 'thread/start').length, 1);
  assert.equal(requests.filter(r => r.method === 'thread/resume').length, 1);
  assert.equal(requests.find(r => r.method === 'thread/start').params.ephemeral, false);
  assert.deepEqual(requests.find(r => r.method === 'turn/start').params.input.slice(1), [{ type: 'localImage', path: '/private/model-images/example.jpg' }]);
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

test('SNAP lookup continues the original thread, attaches images once and sums each stage usage once', async () => {
  const lookups = [], requests = []; let round = 0;
  const c = new CodexClient({ codexHome: '/isolated', timeoutMs: 1000, snapLookup: { defaultRegion: 'cn', lookup: async value => { lookups.push(value); return [{ status: 'ok', cards: [{ name: 'test' }] }]; } } });
  c.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: 'original' }, instructionSources: [] };
    if (method === 'turn/start') {
      const turnId = `stage-${++round}`;
      const event = { method: 'thread/tokenUsage/updated', params: { threadId: 'original', turnId, tokenUsage: { last: usage(round * 100), total: usage(90000) } } };
      c.onMessage(event); c.onMessage(event);
      c.onMessage({ method: 'item/completed', params: { threadId: 'original', turnId, item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(round === 1 ? { lookup: [{ kind: 'card', region: 'cn', query: 'test' }] } : { reply: true, text: '国服：test' }) } } });
      c.onMessage({ method: 'turn/completed', params: { threadId: 'original', turn: { id: turnId, status: 'completed' } } });
      return { turn: { id: turnId } };
    }
    return {};
  };
  let binding;
  const result = await c.answer({ mode: 'selective', replyRequired: true }, { conversation: { threadId: 'original', profile: c.profile }, persist: true, imagePaths: ['/private/image.jpg'], onThread: info => { binding = info; } });
  assert.equal(result.text, '国服：test'); assert.equal(result.modelRequests, 2); assert.equal(result.usage.totalTokens, 320);
  assert.equal(lookups.length, 1); assert.equal(requests.filter(row => row.method === 'thread/resume').length, 1); assert.equal(requests.filter(row => row.method === 'thread/start').length, 0);
  const turns = requests.filter(row => row.method === 'turn/start'); assert.equal(turns[0].params.input.length, 2); assert.equal(turns[1].params.input.length, 1);
  const input = JSON.parse(turns[1].params.input[0].text); assert.equal(input.replyRequired, true); assert.equal(input.snapLookupResults[0].status, 'ok');
  assert.equal(requests.at(-1).method, 'thread/unsubscribe');
  const updates = requests.filter(row => row.method === 'thread/inject_items');
  assert.equal(updates.length, 1); assert.equal(updates[0].params.items[0].role, 'developer');
  assert.match(updates[0].params.items[0].content[0].text, /本机文件/);
  assert.match(binding.instructionsHash, /^[a-f0-9]{64}$/);
  await c.answer({ mode: 'selective' }, { persist: true, conversation: binding });
  assert.equal(requests.filter(row => row.method === 'thread/inject_items').length, 1);
});

test('lookup output cannot open tools without SNAP or in observation-only turns', async () => {
  for (const observeOnly of [false, true]) {
    const c = new CodexClient({ timeoutMs: 1000, ...(observeOnly ? { snapLookup: { defaultRegion: 'cn', lookup: () => assert.fail('must not query') } } : {}) });
    c.request = async method => {
      if (method === 'thread/start') return { thread: { id: 't' } };
      if (method === 'turn/start') {
        c.onMessage({ method: 'item/completed', params: { threadId: 't', turnId: 'one', item: { type: 'agentMessage', phase: 'final_answer', text: '{"lookup":[{"kind":"card","region":"cn","query":"test"}]}' } } });
        c.onMessage({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'one', status: 'completed' } } });
        return { turn: { id: 'one' } };
      }
      return {};
    };
    await assert.rejects(c.answer({ observeOnly }), /not a reply decision/);
  }
});

test('missing usage in a later SNAP stage is reported unknown instead of a partial total', async () => {
  let round = 0;
  const c = new CodexClient({ timeoutMs: 1000, snapLookup: { defaultRegion: 'cn', lookup: async () => [] } });
  c.request = async method => {
    if (method === 'thread/start') return { thread: { id: 't' } };
    if (method === 'turn/start') {
      const turnId = String(++round);
      if (round === 1) c.onMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't', turnId, tokenUsage: { last: usage(100) } } });
      c.onMessage({ method: 'item/completed', params: { threadId: 't', turnId, item: { type: 'agentMessage', phase: 'final_answer', text: round === 1 ? '{"lookup":[{"kind":"card","region":"cn","query":"test"}]}' : '{"reply":false}' } } });
      c.onMessage({ method: 'turn/completed', params: { threadId: 't', turn: { id: turnId, status: 'completed' } } });
      return { turn: { id: turnId } };
    }
    return {};
  };
  const result = await c.answer({}); assert.equal(result.modelRequests, 2); assert.equal(result.usage, null);
});

test('deck code output rejects model-invented codes and accepts only locally issued codes', async () => {
 const ids=Array.from({length:12},(_,i)=>'Card'+i),code=Buffer.from(JSON.stringify({Cards:ids.map(CardDefId=>({CardDefId})),Name:''})).toString('base64');
 for(const trusted of [false,true]){
  let round=0;const c=new CodexClient({timeoutMs:1000,snapLookup:{defaultRegion:'cn',lookup:async()=>[{status:'ok',offline:true,decks:[{code}]}]}});
  c.request=async(method)=>{if(method==='thread/start')return{thread:{id:'t'}};if(method==='turn/start'){const turnId=String(++round);const text=trusted&&round===1?JSON.stringify({lookup:[{kind:'decks',region:'cn'}]}):JSON.stringify({reply:true,text:code});c.onMessage({method:'item/completed',params:{threadId:'t',turnId,item:{type:'agentMessage',phase:'final_answer',text}}});c.onMessage({method:'turn/completed',params:{threadId:'t',turn:{id:turnId,status:'completed'}}});return{turn:{id:turnId}}}return{}};
  const result=await c.answer({mode:'selective'});assert.equal(result.verifiedDeckCode===true,trusted);assert.equal(result.text.includes(code),trusted);
 }
});

test('engine scope comes only from transport options and complete preview cannot be abbreviated by the model',async()=>{
 const calls=[],preview='完整核对\n'+('条件。'.repeat(600))+'\n确认推演 '+ 'a'.repeat(16);let round=0;
 const c=new CodexClient({timeoutMs:1000,snapLookup:{defaultRegion:'cn',engineEnabled:true,lookup:async(_q,options)=>{calls.push(options);return[{query:{kind:'engine_prepare',region:'cn'},status:'awaiting-confirmation',id:'a'.repeat(16),replyText:preview,version:'cn-test'}];}}});const injected=[];
 c.request=async(method,params)=>{if(method==='thread/start')return{thread:{id:'t'}};if(method==='thread/inject_items')injected.push(params);if(method==='turn/start'){const turnId=String(++round);c.onMessage({method:'item/completed',params:{threadId:'t',turnId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(round===1?{lookup:[{kind:'engine_prepare',region:'cn',example:'ironheart'}]}:{reply:true,text:'模型省略了大部分条件'})}}});c.onMessage({method:'turn/completed',params:{threadId:'t',turn:{id:turnId,status:'completed'}}});return{turn:{id:turnId}}}return{}};
 const scope={accountId:'real',groupId:'same',messages:[{sender:'original',text:'准备示例'}]};const result=await c.answer({scope:{accountId:'forged'},messages:[]},{scope});assert.deepEqual(calls[0].scope,scope);assert.equal(result.text,preview);assert.equal(result.enginePreview,true);assert.equal(result.engineOperations[0].status,'awaiting-confirmation');assert.equal(JSON.parse(injected[0].items[0].content[0].text).snapLookupResults[0].replyText,preview);assert.equal(injected[0].items[1].role,'assistant');assert.equal(result.modelRequests,1);
});

test('automatic mechanism lookup uses operator setting and trusted scope, returns to the same thread without a confirmation preview',async()=>{
 const scope={accountId:'pinned',groupId:'group',messages:[{id:'message',sender:'human',text:'验证机制'}]};let round=0;const seen=[];
 const c=new CodexClient({timeoutMs:1000,snapLookup:{defaultRegion:'cn',engineEnabled:true,engineAutoTests:true,lookup:async(q,options)=>{seen.push(options.scope);return[{query:q[0],status:'unsupported-or-failed',hypothetical:true,id:'b'.repeat(16),version:'cn-48.18-dv0',failureCode:'history-dependency',reason:'Stryfe缺少必要历史'}];}}});
 c.request=async(method,p)=>{if(method==='thread/start'){assert.match(p.developerInstructions,/机制测试已获维护者授权自动运行/);return{thread:{id:'same'}};}if(method==='turn/start'){const turnId=String(++round);const decision=round===1?{lookup:[{kind:'engine_test',region:'cn',question:'验证机制',assumptions:['假设'],position:{schema:'snap-position/v1'},focus:[100]}]}:{reply:true,text:'当前合成场景缺少Stryfe依赖的历史，不能确认。'};c.onMessage({method:'item/completed',params:{threadId:'same',turnId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify(decision)}}});c.onMessage({method:'turn/completed',params:{threadId:'same',turn:{id:turnId,status:'completed'}}});return{turn:{id:turnId}};}if(method==='thread/inject_items')assert.fail('must not ask a hypothetical test to confirm');return{}};
 const result=await c.answer({scope:{accountId:'forged'}},{scope});assert.deepEqual(seen,[scope]);assert.equal(result.enginePreview,undefined);assert.equal(result.modelRequests,2);assert.equal(result.engineOperations[0].hypothetical,true);assert.equal(result.engineOperations[0].failureCode,'history-dependency');
});

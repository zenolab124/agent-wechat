import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  engineCatalogMatches,
  createEngineService,
  validateEngineConfig,
  validateEngineLookup,
  validatePosition,
  ironheartExample,
  summarizeSimulation,
} from "../src/engine.mjs";
import { validateLookups } from "../src/snap.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const content = {
  region: "cn",
  identity: { applicationVersion: "48.18", dataVersion: 0 },
  cards: [
    { id: "Ironheart", cost: 3, power: 0 },
    { id: "MistyKnight", cost: 1, power: 3 },
    { id: "Cyclops", cost: 3, power: 5 },
  ],
  locations: [{ id: "Ruins" }],
};
const state = (power) => ({
  cards: [{ entity: 101, definition: "MistyKnight", power }],
  players: [{ energy: 4 }, { energy: 4 }],
  snapshot: {
    value: {
      snapshot: {
        turn: 4,
        totalTurns: 6,
        state: "next-turn",
        locations: [
          { id: 12, definition: "Ruins", p1: power, p2: 5 },
          { id: 13, definition: "Ruins", p1: 0, p2: 0 },
          { id: 14, definition: "Ruins", p1: 0, p2: 0 },
        ],
      },
    },
  },
});
const report = () => ({
  schema: "snap-simulation/v1",
  seeds: 1,
  until: "turn",
  hidden_prior: "none",
  future_actions: "pass",
  runs: [
    {
      seed: 0,
      initial: state(3),
      final: state(5),
      actions: [],
      approximations: ["history-not-assumed"],
      sampled_hidden: false,
      resolution_trace: [
        {
          source: 100,
          effect: "on-reveal",
          changes: [{ target: "card/101/power", before: 3, after: 5 }],
        },
      ],
    },
  ],
  distribution: [{ probability: 1, count: 1, state: state(5) }],
});
function harness(
  t,
  { fail = false, tamper = false, stderr = "/Users/private/secret fail" } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "wx-engine-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "engine"),
    data = join(root, "content.json"),
    verification = join(root, "verified.json");
  writeFileSync(binary, "test-binary");
  writeFileSync(data, JSON.stringify(content));
  const proof = {
    schemaVersion: 1,
    platform: "darwin-arm64",
    version: "cn-48.18-dv0",
    binarySha256: hash("test-binary"),
    contentSha256: hash(readFileSync(data)),
    parity: { expected: 687, equal: 687, unequal: 0 },
    rustWorkspaceTestsPassed: true,
  };
  writeFileSync(verification, JSON.stringify(proof));
  const calls = [],
    config = { binary, content: data, verification, timeoutMs: 3000 },
    directory = join(root, "requests");
  const service = createEngineService({
    config,
    directory,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (fail)
        throw Object.assign(Error("timed out"), {
          stderr,
        });
      const r = report();
      r.seeds = Number(args[args.indexOf("--seeds") + 1]);
      r.runs = Array.from({ length: r.seeds }, () => r.runs[0]);
      r.distribution[0].count = r.seeds;
      if (tamper) r.until = "game";
      writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(r));
    },
  });
  const scope = (
    text = "请准备铁心推演示例",
    sender = "one",
    groupId = "group@chatroom",
    accountId = "account"
  ) => ({ accountId, groupId, messages: [{ sender, text }] });
  const prepare = (extra = {}) =>
    service.lookup(
      {
        kind: "engine_prepare",
        region: "cn",
        example: "ironheart",
        seeds: 1,
        ...extra,
      },
      { scope: scope(), cards: [{ key: "MistyKnight", name: "迷雾骑士" }] }
    );
  const confirm = (id, s = scope("确认推演 " + id)) =>
    service.lookup({ kind: "engine_confirm", region: "cn", id }, { scope: s });
  return {
    root,
    binary,
    data,
    verification,
    proof,
    directory,
    calls,
    config,
    service,
    scope,
    prepare,
    confirm,
  };
}
test("prepare shows complete canonical assumptions and never runs; exact owner confirmation runs once and reuse survives service restart", async (t) => {
  const f = harness(t),
    p = await f.prepare();
  assert.equal(p.status, "awaiting-confirmation");
  assert.equal(f.calls.length, 0);
  assert.match(p.replyText, /迷雾骑士/);
  assert.match(p.replyText, /费1\/力3/);
  assert.match(p.replyText, /假设示例/);
  assert.match(p.replyText, new RegExp("确认推演 " + p.id));
  assert.match(p.replyText, /原始地点/);
  assert.match(p.replyText, /历史/);
  assert.equal((await f.confirm(p.id)).status, "ok");
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.file, f.binary);
  assert.equal(call.options.timeout, 3000);
  assert.equal(call.options.env.AGENT_WECHAT_TOKEN, undefined);
  assert.equal(call.options.shell, undefined);
  assert.ok(call.args.includes(f.data));
  const service = createEngineService({
    config: f.config,
    directory: f.directory,
    run: () => assert.fail("must reuse"),
  });
  const reused = await service.lookup(
    { kind: "engine_confirm", region: "cn", id: p.id },
    { scope: f.scope("确认推演 " + p.id) }
  );
  assert.equal(reused.reused, true);
  assert.equal(reused.summary.firstRun.final.cards[0].power, 5);
});
test("quoted, negative, ambiguous and foreign confirmations cannot execute", async (t) => {
  const f = harness(t),
    p = await f.prepare();
  for (const scope of [
    f.scope("哈哈"),
    {
      ...f.scope("哈哈"),
      messages: [
        { sender: "one", text: "哈哈", quote: { text: "确认推演 " + p.id } },
      ],
    },
    f.scope("不要 确认推演 " + p.id),
    f.scope("有人说 确认推演 " + p.id),
    f.scope("确认推演 " + p.id, "two"),
    f.scope("确认推演 " + p.id, "one", "other@chatroom"),
    f.scope("确认推演 " + p.id, "one", "group@chatroom", "other"),
  ])
    assert.notEqual((await f.confirm(p.id, scope)).status, "ok");
  assert.equal(f.calls.length, 0);
  assert.equal(
    (
      await f.service.lookup(
        { kind: "engine_prepare", region: "cn", example: "ironheart" },
        {
          scope: {
            ...f.scope(),
            messages: [{ sender: "one" }, { sender: "two" }],
          },
        }
      )
    ).status,
    "unavailable"
  );
});
test("strict position validation preserves unknown history, requires origin and never fills absent state", () => {
  const p = ironheartExample(content);
  delete p.history;
  assert.equal(validatePosition(p, content).history, undefined);
  for (const change of [
    (p) => delete p.starting_decks,
    (p) => delete p.locations[0].cards[0][0].origin,
    (p) => (p.players[0].hand[0].entity = 101),
    (p) => (p.actions[0].lane = 3),
    (p) => (p.locations[0].definition = "ForeignLocation"),
    (p) => (p.history = { known: ["fake"] }),
    (p) => {
      p.players[0].deck = 2;
      delete p.hidden_origin;
    },
    (p) => (p.shell = "whoami"),
  ]) {
    const copy = ironheartExample(content);
    change(copy);
    assert.throws(() => validatePosition(copy, content));
  }
});
test("changed binaries, content and parity records fail before execution, including after preparation", async (t) => {
  for (const kind of ["binary", "content", "proof"]) {
    const f = harness(t),
      p = await f.prepare();
    if (kind === "binary") writeFileSync(f.binary, "changed");
    if (kind === "content") writeFileSync(f.data, "{}");
    if (kind === "proof")
      writeFileSync(
        f.verification,
        JSON.stringify({
          ...f.proof,
          parity: { expected: 687, equal: 686, unequal: 1 },
        })
      );
    assert.equal((await f.confirm(p.id)).status, "unavailable");
    assert.equal(f.calls.length, 0);
  }
});
test("failures and incorrect reports have no answer and are never rerun implicitly", async (t) => {
  for (const options of [{ fail: true }, { tamper: true }]) {
    const f = harness(t, options),
      p = await f.prepare();
    const r = await f.confirm(p.id);
    assert.equal(r.status, "unsupported-or-failed");
    assert.ok(!r.summary);
    assert.ok(!r.reason.includes("/Users/"));
    assert.equal((await f.confirm(p.id)).status, "unknown");
    assert.equal(f.calls.length, 1);
  }
});
test("global engine stays unsupported and model cannot supply executable paths or multiple writes", async (t) => {
  const f = harness(t);
  assert.equal(
    (await f.service.lookup({ kind: "engine_status", region: "global" }))
      .status,
    "unsupported"
  );
  assert.equal(f.calls.length, 0);
  assert.throws(() =>
    validateEngineConfig({ ...f.config, binary: "relative" })
  );
  assert.throws(() =>
    validateEngineLookup({ kind: "engine_confirm", region: "cn", id: "../bad" })
  );
  assert.throws(() =>
    validateEngineLookup({
      kind: "engine_prepare",
      region: "cn",
      example: "ironheart",
      binary: "/usr/bin/env",
    })
  );
  assert.throws(() =>
    validateLookups([
      { kind: "engine_prepare", region: "cn", example: "ironheart" },
      { kind: "engine_confirm", region: "cn", id: "a".repeat(16) },
    ])
  );
});
test("summary retains actual effect fields and declares branch or trace truncation", () => {
  const r = report();
  r.seeds = 9;
  r.runs = Array.from({ length: 9 }, () => r.runs[0]);
  r.distribution = Array.from({ length: 9 }, () => ({
    probability: 1 / 9,
    count: 1,
    state: state(5),
  }));
  r.runs[0].resolution_trace = Array.from({ length: 40 }, () => ({
    effect: "on-reveal",
    source: 100,
    changes: [],
  }));
  const s = summarizeSimulation(r);
  assert.equal(s.outcomeCount, 9);
  assert.equal(s.outcomes.length, 8);
  assert.equal(s.outcomesTruncated, true);
  assert.equal(s.firstRun.traceTruncated, true);
  assert.equal(s.firstRun.resolutionTrace[0].effect, "on-reveal");
  assert.equal(s.firstRun.final.cards[0].power, 5);
  assert.equal(s.firstRun.final.snapshot, undefined);
});
test("follow-up reads only the same owner, inherits unchanged conditions and requires a fresh confirmation", async (t) => {
  const f = harness(t),
    p = await f.prepare();
  await f.confirm(p.id);
  const read = await f.service.lookup(
    { kind: "engine_read", region: "cn", id: p.id },
    { scope: f.scope("改到右路呢") }
  );
  assert.equal(read.position.actions[0].lane, 0);
  assert.equal(f.calls.length, 1);
  const next = await f.service.lookup(
    {
      kind: "engine_prepare",
      region: "cn",
      baseId: p.id,
      changes: { actions: [{ kind: "play", player: 0, entity: 100, lane: 2 }] },
    },
    { scope: f.scope("改到右路呢") }
  );
  assert.equal(next.status, "awaiting-confirmation");
  assert.notEqual(next.id, p.id);
  assert.match(next.replyText, /继承推演/);
  assert.deepEqual(next.position.history, p.position.history);
  assert.equal(next.position.actions[0].lane, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.confirm(next.id, f.scope("确认推演 " + p.id))).status,
    "denied"
  );
  assert.equal((await f.confirm(next.id)).status, "ok");
  assert.equal(f.calls.length, 2);
  assert.equal(
    (
      await f.service.lookup(
        { kind: "engine_read", region: "cn", id: p.id },
        { scope: f.scope("给我看看", "other") }
      )
    ).status,
    "denied"
  );
});
function mechanismQuery(extra = {}) {
  return {
    kind: "engine_test",
    region: "cn",
    question: "铁心会给对手加战力吗",
    assumptions: ["假设空牌库、无其他历史，双方各有一张普通牌，我方打出铁心"],
    focus: [100],
    position: ironheartExample(content),
    seeds: 1,
    ...extra,
  };
}

test("operator-enabled mechanism test runs without confirmation, keeps hypothetical scope and deduplicates the same source", async (t) => {
  const f = harness(t);
  f.config.autoMechanismTests = true;
  const scope = f.scope("铁心会给对手加战力吗"),
    q = mechanismQuery();
  const r = await f.service.lookup(q, { scope });
  assert.equal(r.status, "ok");
  assert.equal(r.hypothetical, true);
  assert.equal(r.resultScope, "synthetic-scenario-only");
  assert.equal(f.calls.length, 1);
  assert.match(r.scenario, /自动机制测试/);
  assert.ok(!r.scenario.includes("确认推演"));
  assert.equal(r.summary.triggerCoverage[0].tracedRuns, 1);
  const again = await f.service.lookup(q, { scope });
  assert.equal(again.reused, true);
  assert.equal(f.calls.length, 1);
  const read = await f.service.lookup(
    { kind: "engine_read", region: "cn", id: r.id },
    { scope }
  );
  assert.equal(read.hypothetical, true);
  assert.deepEqual(read.assumptions, q.assumptions);
  assert.equal((await f.confirm(r.id)).status, "denied");
  assert.equal(f.calls.length, 1);
  assert.equal(
    (
      await f.service.lookup(
        { kind: "engine_read", region: "cn", id: r.id },
        { scope: f.scope("看一下", "other") }
      )
    ).status,
    "denied"
  );
});
test("automatic tests cannot be enabled by chat/model fields, and real prepare still waits for its own confirmation", async (t) => {
  const f = harness(t);
  assert.equal(
    (await f.service.lookup(mechanismQuery(), { scope: f.scope() })).status,
    "denied"
  );
  assert.equal(f.calls.length, 0);
  assert.throws(() =>
    validateEngineLookup(mechanismQuery({ confirmed: true }))
  );
  assert.throws(() =>
    validateEngineConfig({ ...f.config, autoMechanismTests: "true" })
  );
  f.config.autoMechanismTests = true;
  const p = await f.prepare();
  assert.equal(p.status, "awaiting-confirmation");
  assert.equal(f.calls.length, 0);
  for (const q of [
    mechanismQuery({ assumptions: [] }),
    mechanismQuery({ focus: [] }),
    mechanismQuery({ question: "" }),
  ])
    assert.throws(() => validateEngineLookup(q));
  assert.notEqual(
    (
      await f.service.lookup(mechanismQuery({ focus: [333] }), {
        scope: f.scope(),
      })
    ).status,
    "ok"
  );
  assert.throws(() =>
    validateLookups([
      mechanismQuery(),
      { kind: "engine_prepare", region: "cn", example: "ironheart" },
    ])
  );
});
test("a completed simulation with absent target trace does not manufacture a trigger, and different messages have distinct test identities", async (t) => {
  const f = harness(t);
  f.config.autoMechanismTests = true;
  const q = mechanismQuery({ focus: [102] });
  const r = await f.service.lookup(q, { scope: f.scope("第一条") });
  assert.equal(r.summary.triggerCoverage[0].tracedRuns, 0);
  assert.deepEqual(r.summary.triggerCoverage[0].effects, []);
  const next = await f.service.lookup(q, { scope: f.scope("第二条") });
  assert.notEqual(next.id, r.id);
  assert.equal(f.calls.length, 2);
});
test("mechanism failures expose actual dependency and never ask for an entire real match or rerun the same failed test", async (t) => {
  const f = harness(t, {
    fail: true,
    stderr:
      "Error: history-dependency: card Stryfe; missing=[UnknownHistory { fact: PlayedBy }]",
  });
  f.config.autoMechanismTests = true;
  const q = mechanismQuery(),
    scope = f.scope();
  const r = await f.service.lookup(q, { scope });
  assert.equal(r.status, "unsupported-or-failed");
  assert.equal(r.failureCode, "history-dependency");
  assert.match(r.reason, /Stryfe/);
  assert.match(r.detail, /PlayedBy/);
  assert.equal(r.summary, undefined);
  assert.match(r.note, /不让用户/);
  const again = await f.service.lookup(q, { scope });
  assert.equal(again.reused, true);
  assert.equal(again.failureCode, "history-dependency");
  assert.equal(f.calls.length, 1);
});

test("mechanism catalog resolves local name abbreviations and retains ambiguity instead of inventing a card", () => {
  const items = [{ id: "ZombieGalacti" }, { id: "Galactus" }, { id: "Stryfe" }],
    names = new Map([
      ["ZombieGalacti", "丧尸吞星"],
      ["Galactus", "吞星"],
      ["Stryfe", "斯特里夫"],
    ]);
  const r = engineCatalogMatches(items, "丧吞", names);
  assert.equal(r.method, "name-subsequence");
  assert.deepEqual(
    r.items.map((c) => c.id),
    ["ZombieGalacti"]
  );
  assert.deepEqual(
    engineCatalogMatches(items, "吞星", names).items.map((c) => c.id),
    ["Galactus"]
  );
  assert.equal(
    engineCatalogMatches(items, "不存在的牌", names).items.length,
    0
  );
  names.set("Stryfe", "丧尸吞月");
  assert.equal(engineCatalogMatches(items, "丧吞", names).items.length, 2);
});

test("missing regional definitions have a concrete cause and never execute a substitute", async (t) => {
  const f = harness(t);
  f.config.autoMechanismTests = true;
  const p = ironheartExample(content);
  p.players[0].hand[0].definition = "MissingCNCard";
  const r = await f.service.lookup(mechanismQuery({ position: p }), {
    scope: f.scope(),
  });
  assert.equal(r.failureCode, "missing-definition");
  assert.match(r.reason, /MissingCNCard/);
  assert.equal(f.calls.length, 0);
});

test('implementation reference is read-only, checks its installed file hash and version, and cannot accept arbitrary paths',async t=>{
 const h=harness(t),reference=join(h.root,'reference.json'),bundle={schema:'snap-engine-reference/v1',region:'cn',version:h.proof.version,contentSha256:h.proof.contentSha256,binarySha256:h.proof.binarySha256,source:'local-rust-implementation-reference',compiledSourceMatch:'not-proven-source-reference-only',fields:[],symbols:[],cards:[{id:'Ironheart',implementation:[],dispatch:[],ledger:{plays:2}}]};const body=JSON.stringify(bundle);writeFileSync(reference,body);const cfg={...h.config,referenceFile:reference,referenceSha256:hash(body)},service=createEngineService({config:cfg,directory:h.directory,run:()=>assert.fail('reference must not execute')});const q={kind:'engine_explain',region:'cn',cards:['Ironheart']};assert.equal((await service.lookup(q)).evidenceTier,'implementation-reference-only');assert.equal((await service.lookup({...q,region:'global'})).status,'unsupported');assert.throws(()=>validateEngineLookup({...q,path:'/etc/passwd'}));writeFileSync(reference,body+' ');assert.equal((await service.lookup(q)).status,'unavailable');writeFileSync(reference,JSON.stringify({...bundle,binarySha256:'0'.repeat(64)}));const bad=createEngineService({config:{...cfg,referenceSha256:hash(JSON.stringify({...bundle,binarySha256:'0'.repeat(64)}))},directory:h.directory});assert.equal((await bad.lookup(q)).status,'unavailable');
});

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
function harness(t, { fail = false, tamper = false } = {}) {
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
          stderr: "/Users/private/secret fail",
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

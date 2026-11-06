import { createHash } from "node:crypto";
import { createEngineService } from "../src/engine.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateOpeningLookup,
  normalizeOpening,
  replayOpening,
} from "../src/opening.mjs";
import { validateLookups } from "../src/snap.mjs";
const ids = Array.from({ length: 12 }, (_, i) => "Card" + i);
const content = {
  identity: { applicationVersion: "48.18", dataVersion: 0 },
  cards: ids.map((id) => ({ id })),
  locations: [{ id: "Ruins" }],
};
const query = () => ({
  kind: "engine_opening_test",
  region: "cn",
  question: "开局测试",
  assumptions: ["合成牌组，对方空过"],
  focus: ["Card0"],
  opening: {
    mode: "Ranked",
    start: "2026-11-06T00:00:00Z",
    decks: [ids, ids],
    locations: ["Ruins", "Ruins", "Ruins"],
    throughTurn: 1,
    actions: [{ kind: "play", turn: 1, player: 0, card: "Card0", lane: 2 }],
  },
});
const snap = (turn = 1) => ({
  turn,
  totalTurns: 6,
  state: "next-turn",
  randomCalls: 3,
  players: [0, 1].map((p) => ({
    account: "player" + p,
    energy: turn,
    hand: [
      { entity: 100 + p, definition: "Card0", owner: "player" + p, power: 1 },
    ],
  })),
  locations: [0, 1, 2].map((i) => ({
    id: 50 + i,
    definition: "Ruins",
    p1: 0,
    p2: 0,
    cards: [],
  })),
});
function harness(t, { bad = false, missing = false, symlink = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "opening-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const run = async (file, args, options) => {
    const scenario = JSON.parse(readFileSync(args[2]));
    calls.push({ scenario, args, options });
    let s = snap();
    if (missing) s.players[0].hand = [];
    const checkpoints = scenario.commands.map((command, step) => {
      const before = structuredClone(s);
      if (command.type === "StageEntityRequest") {
        const card = s.players[command.player].hand.shift();
        if (card) s.locations[2].cards.push(card);
      }
      if (command.type === "EndTurnRequest" && command.player === 1) s.turn++;
      return {
        step,
        command,
        accepted: !bad,
        before: { value: { snapshot: before } },
        after: { value: { snapshot: structuredClone(s) } },
      };
    });
    const report = {
      schema: "cn-duel-core-requests/v1",
      checkpoints,
      divergence: { divergence: bad ? "acceptance" : "termination" },
    };
    if (symlink) {
      const target = join(directory, "target");
      writeFileSync(target, JSON.stringify(report));
      symlinkSync(target, args[3]);
    } else writeFileSync(args[3], JSON.stringify(report));
  };
  return {
    calls,
    run,
    directory,
    config: {
      binary: "/installed/rust-cli",
      content: "/installed/content",
      timeoutMs: 3000,
    },
  };
}
test("opening schema validates complete synthetic decks and ordered bounded actions without arbitrary fields", () => {
  const q = query();
  validateOpeningLookup(q);
  assert.deepEqual(normalizeOpening(q, content), {
    ...q.opening,
    start: new Date(q.opening.start).toISOString(),
  });
  validateLookups([q]);
  for (const mutate of [
    (q) => (q.opening.decks[0] = ids.slice(1)),
    (q) => (q.opening.decks[0] = [...ids.slice(1), ids[1]]),
    (q) => (q.opening.path = "/tmp/input"),
    (q) => (q.opening.actions[0].entity = 123),
    (q) => (q.opening.actions[0].lane = 3),
    (q) => (q.firstSeed = -1),
    (q) => (q.seeds = 129),
    (q) =>
      (q.opening.actions = [
        { ...q.opening.actions[0], turn: 2 },
        q.opening.actions[0],
      ]),
  ]) {
    const v = structuredClone(q);
    mutate(v);
    assert.throws(() => validateOpeningLookup(v));
  }
  const wrong = structuredClone(q);
  wrong.focus = ["Foreign"];
  assert.throws(() => normalizeOpening(wrong, content), /engine-missing-card/);
  wrong.focus = ["Card0"];
  wrong.opening.locations[0] = "Foreign";
  assert.throws(
    () => normalizeOpening(wrong, content),
    /engine-missing-location/
  );
  assert.throws(() => validateLookups([q, q]), /one|single|一次|write/i);
});
test("opening uses two real join requests, snapshot entity IDs, and accepted replay prefixes, never detached simulate", async (t) => {
  const h = harness(t),
    q = query();
  const r = await replayOpening({
    ...h,
    content,
    opening: q.opening,
    focus: q.focus,
    id: "synthetic",
  });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.calls[0].scenario.commands.map((c) => c.type),
    ["JoinRequest", "JoinRequest"]
  );
  assert.equal(h.calls[0].args[0], "replay");
  const action = h.calls[1].scenario.commands[2];
  assert.deepEqual(action.values, {
    Turn: 1,
    EntityId: 100,
    TargetEntityId: 52,
  });
  assert.ok(!("AGENT_WECHAT_TOKEN" in h.calls[0].options.env));
  assert.equal(r.summary.openingInitialized, true);
  assert.equal(r.summary.construction, "from-start");
  assert.equal(r.summary.traceAvailable, false);
  assert.equal(r.summary.firstRun.final.turn, 2);
  assert.equal(r.summary.firstRun.focusSeen[0].observed, true);
  assert.ok(!r.summary.firstRun.resolution_trace);
});
test("a card not drawn is a construction failure with actual hand; rejected and incomplete prefixes cannot claim a mechanism result", async (t) => {
  const q = query();
  await assert.rejects(
    replayOpening({
      ...harness(t, { missing: true }),
      content,
      opening: q.opening,
      focus: q.focus,
      id: "missing",
    }),
    /opening-card-unavailable/
  );
  await assert.rejects(
    replayOpening({
      ...harness(t, { bad: true }),
      content,
      opening: q.opening,
      focus: q.focus,
      id: "bad",
    }),
    /opening-action-rejected/
  );
  const h = harness(t);
  h.run = async (_file, args) =>
    writeFileSync(
      args[3],
      JSON.stringify({ schema: "cn-duel-core-requests/v1", checkpoints: [] })
    );
  await assert.rejects(
    replayOpening({
      ...h,
      content,
      opening: q.opening,
      focus: q.focus,
      id: "incomplete",
    }),
    /Incomplete/
  );
});
test("cancelled, expired and symlink reports fail closed without additional execution", async (t) => {
  const q = query(),
    h = harness(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    replayOpening({
      ...h,
      content,
      opening: q.opening,
      focus: q.focus,
      id: "cancel",
      signal: controller.signal,
    }),
    /abort/i
  );
  assert.equal(h.calls.length, 0);
  let tick = 0;
  await assert.rejects(
    replayOpening({
      ...h,
      content,
      opening: q.opening,
      focus: q.focus,
      id: "timeout",
      now: () => (tick++ ? 10000 : 0),
    }),
    /timeout/i
  );
  assert.equal(h.calls.length, 0);
  await assert.rejects(
    replayOpening({
      ...harness(t, { symlink: true }),
      content,
      opening: q.opening,
      focus: q.focus,
      id: "link",
    }),
    /ELOOP/
  );
});

test("opening service enforces operator gate and trusted scope, reuses results, and preserves from-start context for follow-ups", async (t) => {
  const h = harness(t),
    hash = (x) => createHash("sha256").update(x).digest("hex");
  const binary = join(h.directory, "binary"),
    data = join(h.directory, "content.json"),
    verification = join(h.directory, "verified.json");
  writeFileSync(binary, "fixture");
  writeFileSync(data, JSON.stringify({ ...content, region: "cn" }));
  writeFileSync(
    verification,
    JSON.stringify({
      schemaVersion: 1,
      platform: "darwin-arm64",
      version: "cn-48.18-dv0",
      binarySha256: hash("fixture"),
      contentSha256: hash(readFileSync(data)),
      parity: { expected: 687, equal: 687, unequal: 0 },
      rustWorkspaceTestsPassed: true,
    })
  );
  const config = {
      binary,
      content: data,
      verification,
      timeoutMs: 3000,
      autoMechanismTests: true,
    },
    scope = {
      accountId: "account",
      groupId: "group",
      messages: [{ id: "real-inbound", sender: "human", text: "从开局模拟" }],
    },
    q = query();
  const service = createEngineService({
    config,
    directory: h.directory,
    run: h.run,
  });
  const first = await service.lookup(q, { scope });
  assert.equal(first.status, "ok", JSON.stringify(first));
  assert.equal(first.summary.openingInitialized, true);
  const executions = h.calls.length;
  const again = await service.lookup(q, { scope });
  assert.equal(again.reused, true);
  assert.equal(h.calls.length, executions);
  const read = await service.lookup(
    { kind: "engine_read", region: "cn", id: first.id },
    { scope }
  );
  assert.deepEqual(
    read.opening,
    q.opening.start.endsWith(".000Z")
      ? q.opening
      : { ...q.opening, start: new Date(q.opening.start).toISOString() }
  );
  assert.equal(read.construction, "from-start");
  const denied = await service.lookup(
    { kind: "engine_read", region: "cn", id: first.id },
    { scope: { ...scope, groupId: "other" } }
  );
  assert.equal(denied.status, "denied");
  const disabled = createEngineService({
    config: { ...config, autoMechanismTests: false },
    directory: h.directory,
    run: h.run,
  });
  assert.equal((await disabled.lookup(q, { scope })).status, "denied");
  assert.equal(h.calls.length, executions);
});

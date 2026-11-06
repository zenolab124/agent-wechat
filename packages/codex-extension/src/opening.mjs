import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { join } from "node:path";
const integer = (n, a, b) => Number.isSafeInteger(n) && n >= a && n <= b;
const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
const keys = (x, list) => {
  if (!plain(x) || Object.keys(x).some((k) => !list.includes(k)))
    throw Error("Invalid opening test fields");
};
const ID = /^[A-Za-z0-9_]{1,100}$/;
export function validateOpeningLookup(q) {
  keys(q, [
    "kind",
    "region",
    "question",
    "assumptions",
    "opening",
    "focus",
    "seeds",
    "firstSeed",
    "sender",
  ]);
  if (
    q.kind !== "engine_opening_test" ||
    !["cn", "global"].includes(q.region) ||
    typeof q.question !== "string" ||
    !q.question.trim() ||
    q.question.length > 400 ||
    !Array.isArray(q.assumptions) ||
    !q.assumptions.length ||
    q.assumptions.length > 16 ||
    q.assumptions.some(
      (s) => typeof s !== "string" || !s.trim() || s.length > 240
    ) ||
    !Array.isArray(q.focus) ||
    !q.focus.length ||
    q.focus.length > 8 ||
    q.focus.some((id) => typeof id !== "string" || !ID.test(id)) ||
    (q.seeds !== undefined && !integer(q.seeds, 1, 128)) ||
    (q.firstSeed !== undefined && !integer(q.firstSeed, 0, 2147483520)) ||
    (q.sender !== undefined &&
      (typeof q.sender !== "string" || !q.sender || q.sender.length > 256))
  )
    throw Error("Invalid opening test");
  const o = q.opening;
  keys(o, ["mode", "start", "decks", "locations", "actions", "throughTurn"]);
  if (
    typeof o.mode !== "string" ||
    !ID.test(o.mode) ||
    typeof o.start !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      o.start
    ) ||
    !Number.isFinite(Date.parse(o.start)) ||
    !Array.isArray(o.decks) ||
    o.decks.length !== 2 ||
    o.decks.some(
      (d) =>
        !Array.isArray(d) ||
        d.length !== 12 ||
        new Set(d).size !== 12 ||
        d.some((id) => typeof id !== "string" || !ID.test(id))
    ) ||
    !Array.isArray(o.locations) ||
    o.locations.length !== 3 ||
    o.locations.some((id) => typeof id !== "string" || !ID.test(id)) ||
    !integer(o.throughTurn, 1, 7) ||
    !Array.isArray(o.actions) ||
    o.actions.length > 48
  )
    throw Error(
      "Opening requires complete synthetic decks, locations and ordered actions"
    );
  for (const a of o.actions) {
    keys(a, ["kind", "turn", "player", "card", "lane"]);
    if (
      !["play", "move", "activate"].includes(a.kind) ||
      !integer(a.turn, 1, o.throughTurn) ||
      !integer(a.player, 0, 1) ||
      typeof a.card !== "string" ||
      !ID.test(a.card) ||
      (a.kind !== "activate" && !integer(a.lane, 0, 2)) ||
      (a.kind === "activate" && a.lane !== undefined)
    )
      throw Error("Invalid opening action");
  }
  if (o.actions.some((a, i) => i > 0 && a.turn < o.actions[i - 1].turn))
    throw Error("Opening actions must be ordered by turn");
}
export function normalizeOpening(q, content) {
  validateOpeningLookup(q);
  const cards = new Set(content.cards.map((c) => c.id)),
    locations = new Set(content.locations.map((l) => l.id));
  for (const id of [
    ...q.opening.decks.flat(),
    ...q.opening.actions.map((a) => a.card),
    ...q.focus,
  ])
    if (!cards.has(id)) throw Error("engine-missing-card: " + id);
  for (const id of q.opening.locations)
    if (!locations.has(id)) throw Error("engine-missing-location: " + id);
  return { ...q.opening, start: new Date(q.opening.start).toISOString() };
}
const snapshot = (checkpoint) => checkpoint?.after?.value?.snapshot;
function projected(s) {
  if (
    !s ||
    !Array.isArray(s.players) ||
    s.players.length !== 2 ||
    !Array.isArray(s.locations) ||
    s.locations.length !== 3
  )
    throw Error("Invalid initialized replay snapshot");
  return {
    turn: s.turn,
    totalTurns: s.totalTurns,
    state: s.state,
    randomCalls: s.randomCalls,
    locations: s.locations.map((l) => ({
      id: l.id,
      definition: l.definition,
      power: [l.p1, l.p2],
    })),
    players: s.players.map((p) => ({ energy: p.energy, hand: p.hand })),
    cards: [
      ...s.locations.flatMap((l) => l.cards),
      ...s.players.flatMap((p) => p.hand),
    ],
  };
}
const command = (type, player, values = {}) => ({
  type,
  player,
  values,
  expectAccepted: true,
});
function readReport(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let b;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 32 * 1024 * 1024)
      throw Error("Opening report exceeds local bound");
    b = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const r = JSON.parse(b);
  if (r.schema !== "cn-duel-core-requests/v1" || !Array.isArray(r.checkpoints))
    throw Error("Invalid opening replay report");
  return r;
}

// Uses the installed Rust replay command's Game::new_in_mode and JoinRequest
// path. It never runs the client comparison host or the detached injector.
export async function replayOpening({
  config,
  content,
  opening,
  focus,
  seeds = 1,
  firstSeed = 0,
  directory,
  id,
  run,
  signal,
  now = Date.now,
}) {
  const deadline = now() + (config.timeoutMs ?? 30000),
    runs = [];
  const input = join(directory, id + ".opening.json"),
    output = join(directory, id + ".replay.json");
  for (let seed = firstSeed; seed < firstSeed + seeds; seed++) {
    const commands = [command("JoinRequest", 0), command("JoinRequest", 1)];
    const scenario = {
      schema: "cn-duel-scenario/v1",
      id: id + "-" + seed,
      baseline: {
        region: "cn",
        manifestSha256: "",
        logicSha256: "",
        applicationVersion: content.identity.applicationVersion,
        dataVersion: content.identity.dataVersion,
      },
      inputs: {
        seed,
        mode: opening.mode,
        start: opening.start,
        decks: opening.decks,
        locations: opening.locations,
      },
      commands,
    };
    async function replay() {
      signal?.throwIfAborted();
      const remaining = deadline - now();
      if (remaining <= 0)
        throw Object.assign(Error("Opening test timeout"), {
          name: "TimeoutError",
        });
      writeFileSync(input, JSON.stringify(scenario), { mode: 0o600 });
      await run(
        config.binary,
        ["replay", "--oracle", input, output, "--content", config.content],
        {
          timeout: remaining,
          maxBuffer: 65536,
          signal,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "en_US.UTF-8",
            TMPDIR: directory,
          },
        }
      );
      const r = readReport(output);
      if (r.unsupported) throw Error("unsupported: " + r.unsupported.reason);
      const bad = r.checkpoints.find((c) => c.accepted !== true);
      if (bad || r.divergence?.divergence === "acceptance")
        throw Error(
          "opening-action-rejected: " +
            JSON.stringify(bad?.command ?? r.divergence)
        );
      if (r.checkpoints.length !== commands.length)
        throw Error("Incomplete opening replay");
      return r;
    }
    let report = await replay(),
      s = snapshot(report.checkpoints.at(-1));
    const initial = projected(s),
      resolved = [];
    if (s.turn !== 1)
      throw Error("Opening initialization did not reach turn one");
    for (let turn = 1; turn <= opening.throughTurn; turn++) {
      if (/EndGame$/.test(s.state)) {
        if (opening.actions.some((a) => a.turn >= turn))
          throw Error("Game ended before required action");
        break;
      }
      if (s.turn !== turn)
        throw Error("Opening replay did not reach requested turn");
      const reserved = new Set();
      for (const action of opening.actions.filter((a) => a.turn === turn)) {
        const player = s.players[action.player];
        const pool =
          action.kind === "play"
            ? player.hand
            : s.locations
                .flatMap((l) => l.cards)
                .filter((c) => c.owner === player.account);
        const card = pool.find(
          (c) => c.definition === action.card && !reserved.has(c.entity)
        );
        if (!card)
          throw Error(
            `opening-card-unavailable: seed=${seed}, turn=${turn}, player=${
              action.player
            }, card=${action.card}; available=${pool
              .map((c) => c.definition)
              .join(",")}`
          );
        reserved.add(card.entity);
        const values = {
          Turn: turn,
          EntityId: card.entity,
          ...(action.kind === "activate"
            ? { Activate: true }
            : { TargetEntityId: s.locations[action.lane].id }),
        };
        commands.push(command("StageEntityRequest", action.player, values));
        resolved.push({ ...action, entity: card.entity });
      }
      commands.push(
        command("EndTurnRequest", 0, { EndedTurn: turn }),
        command("EndTurnRequest", 1, { EndedTurn: turn })
      );
      report = await replay();
      s = snapshot(report.checkpoints.at(-1));
      projected(s);
    }
    const steps = report.checkpoints
      .filter((c) => c.step >= 2)
      .map((c) => ({
        step: c.step,
        command: c.command,
        accepted: c.accepted,
        before: projected(c.before.value.snapshot),
        after: projected(c.after.value.snapshot),
      }));
    runs.push({
      seed,
      initial,
      final: projected(s),
      actions: resolved,
      steps,
      focusSeen: focus.map((definition) => ({
        definition,
        observed: report.checkpoints.some((c) =>
          [c.before, c.after].some((v) => {
            const x = v.value.snapshot;
            return [
              ...x.players.flatMap((p) => p.hand),
              ...x.locations.flatMap((l) => l.cards),
            ].some((c) => c.definition === definition);
          })
        ),
      })),
    });
  }
  const grouped = new Map();
  for (const r of runs) {
    const key = JSON.stringify(r.final);
    const entry = grouped.get(key) ?? { count: 0, state: r.final };
    entry.count++;
    grouped.set(key, entry);
  }
  const first = runs[0];
  const summary = {
    seeds,
    firstSeed,
    construction: "from-start",
    openingInitialized: true,
    traceAvailable: false,
    traceLimitation:
      "此replay入口提供每次请求前后快照，不提供逐个揭示/装填的内部轨迹；不能据此捏造触发次数或私有弹药值。",
    outcomeCount: grouped.size,
    outcomes: [...grouped.values()].slice(0, 8).map((o) => ({
      count: o.count,
      probability: o.count / seeds,
      state: { turn: o.state.turn, locations: o.state.locations },
    })),
    outcomesTruncated: grouped.size > 8,
    firstRun: {
      seed: first.seed,
      initial: first.initial,
      final: first.final,
      actions: first.actions,
      steps: first.steps,
      focusSeen: first.focusSeen,
    },
    approximations: [],
    note: "完整执行Rust开局、洗牌、起手与回合流程；双方未列出的动作空过，结果仅适用于所列合成牌组/地点/种子。不是客户端实测或最优出牌。",
  };
  // Bound model input but keep the full operational report on disk.
  while (
    Buffer.byteLength(JSON.stringify(summary)) > 24000 &&
    summary.firstRun.steps.length
  ) {
    summary.firstRun.steps.shift();
    summary.firstRun.stepsTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(summary)) > 24000)
    throw Error("Opening summary exceeds local context bound");
  return {
    summary,
    report: { schema: "snap-opening-simulation/v1", opening, focus, runs },
  };
}

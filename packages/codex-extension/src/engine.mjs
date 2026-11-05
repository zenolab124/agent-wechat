import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  constants,
} from "node:fs";
import { isAbsolute, join } from "node:path";
const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ID = /^[A-Za-z0-9_]{1,100}$/;
const SHA = /^[a-f0-9]{64}$/;
const HISTORY = [
  "played-by",
  "destroy",
  "move",
  "discard",
  "permanent-source",
  "trigger",
  "activate",
  "end-energy",
];
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => {
  if (!plain(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    throw Error("Unexpected simulation fields");
};
const integer = (n, min, max) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
function bytes(path, max = 32 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max)
      throw Error("Invalid local engine file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function validateEngineConfig(config) {
  if (config === undefined) return;
  keys(config, ["binary", "content", "verification", "timeoutMs", "maxSeeds"]);
  if (
    ["binary", "content", "verification"].some(
      (k) => typeof config[k] !== "string" || !isAbsolute(config[k])
    ) ||
    (config.timeoutMs !== undefined &&
      !integer(config.timeoutMs, 100, 120000)) ||
    (config.maxSeeds !== undefined && !integer(config.maxSeeds, 1, 10000))
  )
    throw Error("Invalid local engine configuration");
}
export function validateEngineLookup(query) {
  const allowed = {
    engine_status: ["kind", "region"],
    engine_catalog: ["kind", "region", "query"],
    engine_prepare: [
      "kind",
      "region",
      "position",
      "baseId",
      "changes",
      "example",
      "seeds",
      "until",
      "sender",
    ],
    engine_read: ["kind", "region", "id", "sender"],
    engine_confirm: ["kind", "region", "id", "sender"],
  }[query.kind];
  if (!allowed) throw Error("Unknown engine operation");
  keys(query, allowed);
  if (!["cn", "global"].includes(query.region))
    throw Error("Invalid engine region");
  if (
    query.kind === "engine_catalog" &&
    (typeof query.query !== "string" ||
      !query.query.trim() ||
      query.query.length > 100)
  )
    throw Error("Invalid engine catalog query");
  if (query.kind === "engine_prepare") {
    if (
      [query.position, query.example, query.baseId].filter(
        (v) => v !== undefined
      ).length !== 1 ||
      (query.baseId !== undefined &&
        (typeof query.baseId !== "string" ||
          !/^[a-f0-9]{16}$/.test(query.baseId) ||
          !plain(query.changes))) ||
      (query.changes !== undefined &&
        (query.baseId === undefined ||
          Buffer.byteLength(JSON.stringify(query.changes)) > 32768)) ||
      (query.example !== undefined && query.example !== "ironheart") ||
      (query.position !== undefined &&
        (!plain(query.position) ||
          Buffer.byteLength(JSON.stringify(query.position)) > 32768)) ||
      (query.seeds !== undefined && !integer(query.seeds, 1, 10000)) ||
      (query.until !== undefined && !["turn", "game"].includes(query.until)) ||
      (query.sender !== undefined &&
        (typeof query.sender !== "string" || query.sender.length > 256))
    )
      throw Error("Invalid engine proposal");
  }
  if (
    ["engine_confirm", "engine_read"].includes(query.kind) &&
    (typeof query.id !== "string" || !/^[a-f0-9]{16}$/.test(query.id))
  )
    throw Error("Invalid simulation confirmation");
  if (
    ["engine_read", "engine_confirm"].includes(query.kind) &&
    query.sender !== undefined &&
    (typeof query.sender !== "string" ||
      !query.sender ||
      query.sender.length > 256)
  )
    throw Error("Invalid simulation reader");
}
export function validatePosition(position, content) {
  keys(position, [
    "schema",
    "mode",
    "start",
    "turn",
    "total_turns",
    "priority",
    "locations",
    "players",
    "actions",
    "history",
    "hidden_pool",
    "hidden_origin",
    "starting_decks",
    "starting_locations",
  ]);
  if (
    position.schema !== "snap-position/v1" ||
    typeof position.mode !== "string" ||
    !ID.test(position.mode) ||
    typeof position.start !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      position.start
    ) ||
    !Number.isFinite(Date.parse(position.start)) ||
    !integer(position.turn, 1, 100) ||
    !integer(position.total_turns, position.turn, 100) ||
    !integer(position.priority, 0, 1) ||
    !Array.isArray(position.locations) ||
    position.locations.length !== 3 ||
    !Array.isArray(position.players) ||
    position.players.length !== 2 ||
    !Array.isArray(position.actions) ||
    position.actions.length > 64 ||
    !Array.isArray(position.starting_decks) ||
    position.starting_decks.length !== 2 ||
    !Array.isArray(position.starting_locations) ||
    position.starting_locations.length !== 3
  )
    throw Error("Incomplete detached position");
  const cardIds = new Set(content.cards.map((c) => c.id)),
    locations = new Set(content.locations.map((l) => l.id)),
    entities = new Set();
  const card = (c) => {
    keys(c, [
      "entity",
      "definition",
      "power",
      "cost",
      "revealed",
      "activated",
      "origin",
    ]);
    if (
      !integer(c.entity, 100, 9999) ||
      entities.has(c.entity) ||
      (c.definition !== null &&
        (typeof c.definition !== "string" || !cardIds.has(c.definition))) ||
      typeof c.revealed !== "boolean" ||
      !["generated", "starting-deck"].includes(c.origin) ||
      ["power", "cost"].some(
        (k) =>
          c[k] !== undefined &&
          c[k] !== null &&
          !integer(c[k], -1000000, 1000000)
      ) ||
      (c.activated !== undefined && typeof c.activated !== "boolean")
    )
      throw Error("Invalid or unknown engine card");
    entities.add(c.entity);
  };
  const zone = (value) => {
    if (Array.isArray(value)) {
      if (value.length > 64) throw Error("Zone too large");
      value.forEach(card);
    } else if (!integer(value, 0, 64))
      throw Error("Unknown zone must be a card count");
  };
  for (const location of position.locations) {
    keys(location, ["definition", "revealed", "power", "cards"]);
    if (
      !locations.has(location.definition) ||
      typeof location.revealed !== "boolean" ||
      !Array.isArray(location.power) ||
      location.power.length !== 2 ||
      location.power.some((n) => !integer(n, -1000000000, 1000000000)) ||
      !Array.isArray(location.cards) ||
      location.cards.length !== 2 ||
      location.cards.some((row) => !Array.isArray(row) || row.length > 16)
    )
      throw Error("Invalid engine location");
    location.cards.flat().forEach(card);
  }
  for (const player of position.players) {
    keys(player, ["energy", "hand", "deck"]);
    if (!integer(player.energy, 0, 1000000)) throw Error("Unknown energy");
    zone(player.hand);
    zone(player.deck);
  }
  if (
    entities.size > 128 ||
    position.starting_decks.some(
      (deck) =>
        !Array.isArray(deck) ||
        deck.length > 64 ||
        deck.some((id) => !cardIds.has(id))
    ) ||
    position.starting_locations.some((id) => !locations.has(id))
  )
    throw Error("Invalid starting identities");
  if (
    (position.hidden_origin !== undefined &&
      !["generated", "starting-deck"].includes(position.hidden_origin)) ||
    (position.hidden_pool !== undefined &&
      (!Array.isArray(position.hidden_pool) ||
        !position.hidden_pool.length ||
        position.hidden_pool.length > 128 ||
        position.hidden_pool.some((id) => !cardIds.has(id))))
  )
    throw Error("Invalid hidden prior");
  if (
    position.players.some((p) =>
      [p.hand, p.deck].some((z) => typeof z === "number" && z > 0)
    ) &&
    !position.hidden_origin
  )
    throw Error("Unknown hidden-card origin requires clarification");
  if (position.history !== undefined) {
    keys(position.history, ["known", "events"]);
    if (
      (position.history.known !== undefined &&
        (!Array.isArray(position.history.known) ||
          new Set(position.history.known).size !==
            position.history.known.length ||
          position.history.known.some((k) => !HISTORY.includes(k)))) ||
      (position.history.events !== undefined &&
        (!Array.isArray(position.history.events) ||
          position.history.events.length > 128 ||
          position.history.events.some(
            (e) =>
              !plain(e) ||
              typeof e.type !== "string" ||
              Buffer.byteLength(JSON.stringify(e)) > 4096
          )))
    )
      throw Error("Invalid declared history");
  }
  for (const action of position.actions) {
    keys(
      action,
      action.kind === "activate"
        ? ["kind", "player", "entity", "turn"]
        : ["kind", "player", "entity", "lane", "turn"]
    );
    if (
      !["play", "move", "activate"].includes(action.kind) ||
      !integer(action.player, 0, 1) ||
      !entities.has(action.entity) ||
      (action.kind !== "activate" && !integer(action.lane, 0, 2)) ||
      (action.turn !== undefined &&
        !integer(action.turn, position.turn, position.total_turns))
    )
      throw Error("Invalid engine action");
  }
  return { ...position, start: new Date(position.start).toISOString() };
}
export function ironheartExample(content) {
  const value = (id) => content.cards.find((c) => c.id === id);
  const c = (entity, definition, revealed) => ({
    entity,
    definition,
    power: null,
    cost: null,
    revealed,
    activated: false,
    origin: "generated",
  });
  const empty = () => ({
    definition: "Ruins",
    revealed: true,
    power: [0, 0],
    cards: [[], []],
  });
  return {
    schema: "snap-position/v1",
    mode: "Ranked",
    start: "2026-11-06T00:00:00+08:00",
    turn: 3,
    total_turns: 6,
    priority: 0,
    locations: [
      {
        ...empty(),
        power: [value("MistyKnight").power, value("Cyclops").power],
        cards: [[c(101, "MistyKnight", true)], [c(102, "Cyclops", true)]],
      },
      empty(),
      empty(),
    ],
    players: [
      { energy: 3, hand: [c(100, "Ironheart", false)], deck: [] },
      { energy: 3, hand: [], deck: [] },
    ],
    actions: [{ kind: "play", player: 0, entity: 100, lane: 0 }],
    history: { known: HISTORY, events: [] },
    starting_decks: [[], []],
    starting_locations: ["Ruins", "Ruins", "Ruins"],
    hidden_origin: "generated",
  };
}
function preview(position, request, id, names, version, content) {
  const definitions = new Map(content.cards.map((c) => [c.id, c]));
  const name = (id) => names.get(id) || id;
  const card = (c) =>
    `#${c.entity} ${name(c.definition ?? "未知身份")}（${
      c.origin === "generated" ? "效果生成" : "起始牌组"
    }，${c.revealed ? "已揭示" : "未揭示"}${
      c.activated === true
        ? "，已激活"
        : c.activated === false
        ? "，未激活"
        : "，激活状态未提供（按未激活）"
    }，费${c.cost ?? definitions.get(c.definition)?.cost ?? "未知"}/力${
      c.power ?? definitions.get(c.definition)?.power ?? "未知"
    }）`;
  const zone = (z) =>
    typeof z === "number"
      ? `${z}张身份未明`
      : z.length
      ? z.map(card).join("、")
      : "明确为空";
  const lines = [
    `待确认推演 ${id}`,
    `规则：${version}；${position.mode}，第${position.turn}/${
      position.total_turns
    }回合，${position.priority === 0 ? "我方" : "对方"}先手。`,
    `开局日期：${new Date(position.start).toLocaleString("sv-SE", {
      timeZone: "Asia/Shanghai",
    })} 北京时间（引擎UTC ${position.start}；仅筛选卡池，不切换历史规则）。`,
  ];
  for (const [i, l] of position.locations.entries())
    lines.push(
      `${["左", "中", "右"][i]}路：${name(l.definition)}，${
        l.revealed ? "已揭示" : "未揭示"
      }，战力我${l.power[0]}/敌${l.power[1]}；我方 ${zone(
        l.cards[0]
      )}；对方 ${zone(l.cards[1])}。`
    );
  for (const [i, p] of position.players.entries())
    lines.push(
      `${i === 0 ? "我方" : "对方"}：能量${p.energy}；手牌 ${zone(
        p.hand
      )}；牌库 ${zone(p.deck)}；起始牌组 ${
        position.starting_decks[i].length
          ? position.starting_decks[i].map(name).join("、")
          : "明确为空（假设）"
      }。`
    );
  lines.push(
    `原始地点：${position.starting_locations.map(name).join("、")}。`,
    `动作：${
      position.actions.length
        ? position.actions
            .map(
              (a) =>
                `${a.turn ?? position.turn}回合${
                  a.player === 0 ? "我方" : "对方"
                }${{ play: "打出", move: "移动", activate: "激活" }[a.kind]}#${
                  a.entity
                }${
                  a.lane !== undefined
                    ? "到" + ["左", "中", "右"][a.lane] + "路"
                    : ""
                }`
            )
            .join("；")
        : "无指定动作，双方空过"
    }。`,
    `历史已声明完整：${
      (position.history?.known ?? []).join("、") || "无"
    }；未声明：${
      HISTORY.filter((k) => !position.history?.known?.includes(k)).join("、") ||
      "无"
    }；已列事件：${JSON.stringify(position.history?.events ?? [])}。`,
    `隐藏身份来源：${position.hidden_origin ?? "未指定"}；先验：${
      position.hidden_pool?.map(name).join("、") ||
      "如需抽样，按所选模式/日期卡池均匀假设，不代表真实对手"
    }。`,
    `计算：${
      request.until === "game"
        ? "至终局（后续未列动作均空过）"
        : "本回合结束并含下一回合开始效果"
    }，${request.seeds}个随机种子。`,
    `请核对以上条件；缺失或错误请先补充。确认后原样回复：确认推演 ${id}`
  );
  const text = lines.join("\n");
  if (text.length > 9000)
    throw Error("Position preview is too long to confirm completely");
  return text;
}
function safeError(error) {
  return String(error.stderr ?? error.message ?? "engine failed")
    .replace(/\/(?:Users|Volumes|private|tmp)\/[^\s"']+/g, "[本机路径]")
    .slice(0, 1200);
}
function projectState(value, includeCards = true) {
  const snapshot = value?.snapshot?.value?.snapshot;
  if (
    !snapshot ||
    !Array.isArray(snapshot.locations) ||
    snapshot.locations.length !== 3 ||
    !Array.isArray(value.cards) ||
    !Array.isArray(value.players)
  )
    throw Error("Missing simulation state");
  return {
    turn: snapshot.turn,
    totalTurns: snapshot.totalTurns,
    state: snapshot.state,
    randomCalls: snapshot.randomCalls,
    locations: snapshot.locations.map((l) => ({
      id: l.id,
      definition: l.definition,
      power: [l.p1, l.p2],
    })),
    players: value.players,
    ...(includeCards ? { cards: value.cards } : {}),
  };
}
export function summarizeSimulation(report) {
  if (
    report?.schema !== "snap-simulation/v1" ||
    !integer(report.seeds, 1, 10000) ||
    !Array.isArray(report.runs) ||
    report.runs.length !== report.seeds ||
    !Array.isArray(report.distribution) ||
    !report.distribution.length ||
    report.distribution.reduce((n, d) => n + d.count, 0) !== report.seeds
  )
    throw Error("Invalid simulation report");
  const first = report.runs[0],
    approximations = [
      ...new Set(
        report.runs
          .flatMap((r) => r.approximations ?? [])
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      ),
    ];
  const outcomes = report.distribution.slice(0, 8).map((d) => ({
    probability: d.probability,
    count: d.count,
    state: projectState(d.state, false),
  }));
  const trace = first.resolution_trace ?? [];
  const summary = {
    seeds: report.seeds,
    until: report.until,
    hiddenPrior: report.hidden_prior,
    sampledHidden: report.runs.some((r) => r.sampled_hidden),
    futureActions: report.future_actions,
    approximations,
    outcomeCount: report.distribution.length,
    outcomes,
    outcomesTruncated: report.distribution.length > 8,
    firstRun: {
      seed: first.seed,
      initial: projectState(first.initial),
      final: projectState(first.final),
      actions: first.actions,
      resolutionTrace: trace.slice(0, 32),
      traceTruncated: trace.length > 32,
    },
  };
  // Preserve complete initial/final conditions; cut only the optional trace and
  // mark it. Never feed an unbounded engine report into model context.
  while (
    Buffer.byteLength(JSON.stringify(summary)) > 24000 &&
    summary.firstRun.resolutionTrace.length
  ) {
    summary.firstRun.resolutionTrace.pop();
    summary.firstRun.traceTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(summary)) > 24000)
    throw Error("Simulation summary exceeds local context limit");
  return summary;
}
export function createEngineService({
  config,
  directory,
  now = Date.now,
  run = execute,
  signal,
} = {}) {
  validateEngineConfig(config);
  function installed() {
    const proof = JSON.parse(bytes(config.verification)),
      binary = bytes(config.binary, 128 * 1024 * 1024),
      contentBytes = bytes(config.content);
    if (
      proof.schemaVersion !== 1 ||
      proof.platform !== "darwin-arm64" ||
      !/^cn-\d+\.\d+-dv\d+$/.test(proof.version) ||
      !integer(proof.parity?.expected, 1, 1000000) ||
      proof.parity.equal !== proof.parity.expected ||
      proof.parity?.unequal !== 0 ||
      proof.rustWorkspaceTestsPassed !== true ||
      !SHA.test(proof.binarySha256) ||
      !SHA.test(proof.contentSha256) ||
      digest(binary) !== proof.binarySha256 ||
      digest(contentBytes) !== proof.contentSha256
    )
      throw Error("Engine verification mismatch");
    const content = JSON.parse(contentBytes);
    if (
      content.region !== "cn" ||
      proof.version !==
        `cn-${content.identity.applicationVersion}-dv${content.identity.dataVersion}` ||
      !Array.isArray(content.cards) ||
      !Array.isArray(content.locations)
    )
      throw Error("Engine/content identity mismatch");
    return { proof, content };
  }
  function owner(scope, sender) {
    if (
      !scope ||
      typeof scope.accountId !== "string" ||
      typeof scope.groupId !== "string" ||
      !Array.isArray(scope.messages)
    )
      throw Error("Missing engine request scope");
    const ids = [...new Set(scope.messages.map((m) => m.sender))];
    const actor = sender ?? (ids.length === 1 ? ids[0] : null);
    if (!actor || !ids.includes(actor))
      throw Error("Ambiguous simulation requester");
    return {
      accountId: scope.accountId,
      groupId: scope.groupId,
      sender: actor,
    };
  }
  function save(id, value) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `.${id}-${randomBytes(6).toString("hex")}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, join(directory, id + ".json"));
    const parent = openSync(directory, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  const service = {
    async lookup(query, { scope, cards = [], locations = [] } = {}) {
      validateEngineLookup(query);
      if (query.region !== "cn")
        return {
          status: "unsupported",
          offline: true,
          reason: "仅安装国服引擎，不借用国际服事实。",
        };
      try {
        const { proof, content } = installed(),
          metadata = {
            offline: true,
            version: proof.version,
            evidenceTier: "engine-verified-portability",
            macEngineVerified: true,
            parityCases: proof.parity.equal,
            verifiedAt: proof.verifiedAt ?? null,
          };
        if (query.kind === "engine_status")
          return {
            status: "ok",
            ...metadata,
            capabilities: [
              "detached-position-confirmation",
              "specified-actions-simulation",
            ],
            inputFormat: {
              schema: "snap-position/v1",
              mode: "content mode ID，例如Ranked",
              start:
                "真实开局带时区ISO时间，仅筛选当时卡池，规则仍是当前引擎版本",
              turn: "当前回合整数",
              total_turns: "总回合数整数",
              priority: "0我方先手或1对方先手",
              locations:
                "恰3项 {definition:地点ID,revealed:boolean,power:[我方,对方],cards:[[我方Card],[对方Card]]}",
              players:
                "恰2项 {energy:整数,hand:[Card]或未知身份张数,deck:[Card]或未知身份张数}",
              Card: "{entity:全局唯一100..9999,definition:卡ID或null未知,power:实际战力或null用引擎印刷值,cost:实际费用或null用印刷值,revealed:boolean,activated?:boolean,origin:generated或starting-deck}。来源不明必须问，不能默认生成牌。",
              actions:
                "{kind:play或move,player:0或1,entity,lane:0左1中2右,turn?:整数} 或 {kind:activate,player,entity,turn?}",
              starting_decks: "双方真实开局卡牌ID列表[[],[]]；未知不能填空",
              starting_locations: "三个原始地点ID列表；未知不能填当前地点",
              history:
                "可省略以保持未知。{known:已声明完整的事实类别[],events:真实事件列表[]}。known只可played-by/destroy/move/discard/permanent-source/trigger/activate/end-energy；没说的类别不能填。具体事件格式不明先澄清，不编造。",
              hidden_pool:
                "可选：显式均匀先验卡ID数组，否则按模式/开局时间卡池。非对手真实卡组",
              hidden_origin:
                "身份未知且有隐藏牌时必须明确generated或starting-deck",
            },
            note: "仅Rust引擎推算，不是客户端实测；不提供最优出牌搜索或裁判入口。",
          };
        const names = new Map(
          [
            ...cards.map((c) => [c.key, c.name]),
            ...locations.map((l) => [l.key, l.name]),
          ].filter(([, name]) => name)
        );
        if (query.kind === "engine_catalog") {
          const q = query.query.toLowerCase();
          return {
            status: "ok",
            ...metadata,
            cards: content.cards
              .filter((c) =>
                [c.id, names.get(c.id)].some((n) =>
                  n?.toLowerCase().includes(q)
                )
              )
              .slice(0, 12)
              .map((c) => ({
                id: c.id,
                name: names.get(c.id) ?? null,
                cost: c.cost,
                power: c.power,
                type: c.type,
              })),
            locations: content.locations
              .filter((l) =>
                [l.id, names.get(l.id)].some((n) =>
                  n?.toLowerCase().includes(q)
                )
              )
              .slice(0, 8)
              .map((l) => ({ id: l.id, name: names.get(l.id) ?? null })),
            note: "目录有定义不代表所有能力/组合已实现，最终仍可能因不支持或历史不明而拒绝。",
          };
        }
        if (query.kind === "engine_read") {
          const binding = owner(scope, query.sender),
            saved = JSON.parse(
              bytes(join(directory, query.id + ".json"), 131072)
            );
          if (JSON.stringify(binding) !== JSON.stringify(saved.binding))
            return {
              status: "denied",
              ...metadata,
              reason: "该任务不属于本群当前提问者或账号。",
            };
          return {
            status: "ok",
            ...metadata,
            id: saved.id,
            taskVersion: saved.version,
            versionChanged:
              saved.binarySha256 !== proof.binarySha256 ||
              saved.contentSha256 !== proof.contentSha256,
            state: saved.state,
            position: saved.position,
            request: saved.request,
            summary: saved.summary ?? null,
            note: "只读取已保留的推演任务，不新增计算；改变条件需用baseId与changes准备新任务并重新确认。",
          };
        }
        if (query.kind === "engine_prepare") {
          const binding = owner(scope, query.sender);
          let base;
          if (query.baseId) {
            base = JSON.parse(
              bytes(join(directory, query.baseId + ".json"), 131072)
            );
            if (
              JSON.stringify(binding) !== JSON.stringify(base.binding) ||
              base.binarySha256 !== proof.binarySha256 ||
              base.contentSha256 !== proof.contentSha256
            )
              return {
                status: "denied",
                ...metadata,
                reason:
                  "原局面不属于本提问者/群/账号或引擎已变更，请重新整理完整局面。",
              };
            keys(query.changes, [
              "mode",
              "start",
              "turn",
              "total_turns",
              "priority",
              "locations",
              "players",
              "actions",
              "history",
              "hidden_pool",
              "hidden_origin",
              "starting_decks",
              "starting_locations",
            ]);
          }
          const position = validatePosition(
            base
              ? { ...base.position, ...query.changes }
              : query.example
              ? ironheartExample(content)
              : query.position,
            content
          );
          const request = {
            seeds: query.seeds ?? base?.request.seeds ?? 32,
            until: query.until ?? base?.request.until ?? "turn",
          };
          if (request.seeds > (config.maxSeeds ?? 128))
            return {
              status: "invalid",
              ...metadata,
              reason:
                "单次模拟样本数超过本机执行边界，请减少种子数后重新准备。",
            };
          const id = randomBytes(8).toString("hex"),
            text =
              (base
                ? `继承推演 ${base.id} 的已列条件，修改项：${Object.keys(
                    query.changes
                  ).join("、")}；仍需重新核对。\n`
                : query.example
                ? "假设示例（不是你的真实对局；全部空区与空历史均为本示例设定）\n"
                : "") +
              preview(position, request, id, names, proof.version, content),
            proposal = {
              schemaVersion: 1,
              id,
              binding,
              position,
              request,
              version: proof.version,
              binarySha256: proof.binarySha256,
              contentSha256: proof.contentSha256,
              preview: text,
              ...(base
                ? { baseId: base.id, changedFields: Object.keys(query.changes) }
                : {}),
              state: "prepared",
              createdAt: now(),
            };
          save(id, proposal);
          return {
            status: "awaiting-confirmation",
            ...metadata,
            id,
            replyText: text,
            position,
            request,
            note: "尚未运行引擎。只有本群同一提问者新发的确认短语才能执行；群消息或模型不能自行确认。",
          };
        }
        const id = query.id,
          proposal = JSON.parse(bytes(join(directory, id + ".json"), 131072)),
          binding = owner(scope, proposal.binding.sender);
        if (
          (query.sender !== undefined && query.sender !== binding.sender) ||
          JSON.stringify(binding) !== JSON.stringify(proposal.binding) ||
          proposal.binarySha256 !== proof.binarySha256 ||
          proposal.contentSha256 !== proof.contentSha256
        )
          return {
            status: "denied",
            ...metadata,
            reason: "提问者/群/账号或引擎版本不匹配，请重新准备。",
          };
        const confirmed = scope.messages.some(
          (m) =>
            m.sender === binding.sender &&
            new RegExp("^确认推演\\s+" + id + "$").test((m.text ?? "").trim())
        );
        if (!confirmed)
          return {
            status: "denied",
            ...metadata,
            reason: "没有收到本群原提问者的新确认消息，不能运行。",
          };
        if (proposal.state === "done")
          return {
            status: "ok",
            ...metadata,
            id,
            reused: true,
            summary: proposal.summary,
            durationMs: proposal.durationMs,
            note: "复用同一确认任务的结果，没有再次计算。结果是明确条件下的Rust推算，不是客户端实测或实战胜率。",
          };
        if (proposal.state !== "prepared")
          return {
            status: "unknown",
            ...metadata,
            id,
            reason:
              "此任务之前已开始或失败，不自动重算；请重新准备一个新任务。",
          };
        const positionFile = join(directory, id + ".position.json"),
          output = join(directory, id + ".report.json");
        writeFileSync(positionFile, JSON.stringify(proposal.position), {
          mode: 0o600,
          flag: "wx",
        });
        proposal.state = "running";
        save(id, proposal);
        const began = now();
        try {
          await run(
            config.binary,
            [
              "simulate",
              "--position",
              positionFile,
              "--out",
              output,
              "--seeds",
              String(proposal.request.seeds),
              "--until",
              proposal.request.until,
              "--content",
              config.content,
            ],
            {
              timeout: config.timeoutMs ?? 30000,
              maxBuffer: 65536,
              signal,
              env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                LANG: "en_US.UTF-8",
                TMPDIR: directory,
              },
            }
          );
          const raw = bytes(output, 32 * 1024 * 1024),
            report = JSON.parse(raw);
          if (
            report.seeds !== proposal.request.seeds ||
            report.until !== proposal.request.until
          )
            throw Error("Engine report differs from request");
          const summary = summarizeSimulation(report);
          proposal.state = "done";
          proposal.summary = summary;
          proposal.durationMs = now() - began;
          proposal.reportSha256 = digest(raw);
          save(id, proposal);
          return {
            status: "ok",
            ...metadata,
            id,
            durationMs: proposal.durationMs,
            summary,
            note: "这是用户确认条件下的Rust引擎推算，不是本次客户端实测。抽样分布仅是已声明先验/种子下的结果，不是实战胜率；完整报告保留本机，不把未指定后续动作当作最优出牌。",
          };
        } catch (error) {
          proposal.state = "failed";
          save(id, proposal);
          return {
            status: "unsupported-or-failed",
            ...metadata,
            id,
            reason: safeError(error),
            note: "没有可用推演结论，不得脑补结果；缺失条件请向提问者澄清后重新准备。",
          };
        }
      } catch (error) {
        return {
          status: "unavailable",
          offline: true,
          reason:
            "本机引擎未通过校验、任务不存在或输入条件不完整。" +
            safeError(error),
        };
      }
    },
  };
  return service;
}

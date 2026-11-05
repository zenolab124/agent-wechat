const normalize = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•・:：—\-_’'“”"（）()]/g, "");
const validDate = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const key = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{1,100}$/.test(value);
const nullableText = (value) =>
  value === null || (typeof value === "string" && value.length <= 4096);
export function validateKnowledgeLookup(query) {
  if (
    !["cn", "global"].includes(query.region) ||
    Object.keys(query).some((k) => !["kind", "region", "query"].includes(k)) ||
    !["location", "location_schedule", "rules"].includes(query.kind) ||
    (query.kind !== "location_schedule" &&
      (typeof query.query !== "string" ||
        !query.query.trim() ||
        query.query.length > 160)) ||
    (query.query !== undefined &&
      (typeof query.query !== "string" || query.query.length > 160))
  )
    throw Error("Invalid local knowledge query");
}
export function parseLocations(value, region) {
  if (
    value?.schemaVersion !== 1 ||
    value.region !== region ||
    !Array.isArray(value.locations) ||
    value.counts?.total !== value.locations.length
  )
    throw Error("Invalid local locations");
  const seen = new Set();
  return value.locations.map((row) => {
    if (
      !key(row.defId) ||
      seen.has(row.defId) ||
      !["runtime", "localization-only"].includes(row.definitionStatus) ||
      [
        "nameCn",
        "nameOriginal",
        "effect",
        "effectTemplate",
        "tipOriginal",
      ].some((k) => !nullableText(row[k])) ||
      (row.testOnly !== null && typeof row.testOnly !== "boolean") ||
      ["firstBasePoolAt", "scheduledReleaseAt"].some(
        (k) => row[k] !== null && !validDate(row[k])
      )
    )
      throw Error("Invalid local location record");
    seen.add(row.defId);
    return {
      key: row.defId,
      region,
      name: row.nameCn,
      originalName: row.nameOriginal,
      definitionStatus: row.definitionStatus,
      testOnly: row.testOnly,
      effect:
        (row.effect && !/[{}]/.test(row.effect) ? row.effect : null) ??
        (row.effectTemplate && !/[{}]/.test(row.effectTemplate)
          ? row.effectTemplate
          : null),
      effectTemplate: row.effectTemplate,
      effectResolutionStatus: row.effectResolutionStatus ?? null,
      firstBasePoolAt: row.firstBasePoolAt,
      scheduledReleaseAt: row.scheduledReleaseAt,
      tip: row.tipOriginal,
    };
  });
}
export function parseLocationSchedule(value, region) {
  if (
    value?.schemaVersion !== 1 ||
    value.region !== region ||
    !Array.isArray(value.entries) ||
    value.count !== value.entries.length ||
    typeof value.provisional !== "boolean"
  )
    throw Error("Invalid local location schedule");
  const seen = new Set();
  const entries = value.entries.map((row) => {
    if (
      typeof row.id !== "string" ||
      !row.id ||
      seen.has(row.id) ||
      !key(row.locationId) ||
      !["hot", "featured", "unknown"].includes(row.kind) ||
      !validDate(row.startsAt) ||
      !validDate(row.endsAt) ||
      Date.parse(row.endsAt) <= Date.parse(row.startsAt)
    )
      throw Error("Invalid schedule window");
    seen.add(row.id);
    return {
      id: row.id,
      locationId: row.locationId,
      kind: row.kind,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    };
  });
  return {
    entries,
    provisional: value.provisional,
    modeScopeStatus:
      typeof value.modeScopeStatus === "string"
        ? value.modeScopeStatus
        : "unknown",
  };
}
export function queryLocations(query, locations, schedule, now = Date.now()) {
  if (query.kind === "location") {
    const q = normalize(query.query),
      exact = locations.filter((row) =>
        [row.key, row.name, row.originalName].some(
          (name) => name && normalize(name) === q
        )
      );
    const found = exact.length
      ? exact
      : locations.filter((row) =>
          [row.key, row.name, row.originalName].some(
            (name) => name && normalize(name).includes(q)
          )
        );
    return {
      status: found.length ? "ok" : "not-found",
      ambiguous: found.length > 1,
      truncated: found.length > 8,
      locations: found.slice(0, 8),
      note: "地点效果仅为该服离线资料。runtime表示有客户端定义，不等于当前可出现；localization-only仅有文字。缺失数值或模板参数保持未知，不能推断未验证组合结算。",
    };
  }
  if (!schedule)
    return {
      status: "unavailable",
      reason: "本机没有通过校验的本服地点排期。",
    };
  const q = normalize(query.query),
    ids = q
      ? new Set(
          locations
            .filter((row) =>
              [row.key, row.name, row.originalName].some(
                (name) => name && normalize(name).includes(q)
              )
            )
            .map((row) => row.key)
        )
      : null;
  const entries = schedule.entries
    .filter((row) => !ids || ids.has(row.locationId))
    .map((row) => ({
      ...row,
      location: locations.find((l) => l.key === row.locationId) ?? null,
      state:
        now < Date.parse(row.startsAt)
          ? "upcoming"
          : now >= Date.parse(row.endsAt)
          ? "ended"
          : "active",
    }));
  const active = entries.filter((row) => row.state === "active"),
    upcoming = entries
      .filter((row) => row.state === "upcoming")
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .slice(0, 6);
  return {
    status: "ok",
    provisional: schedule.provisional,
    modeScopeStatus: schedule.modeScopeStatus,
    asOf: new Date(now).toISOString(),
    active,
    upcoming,
    coverageThrough: entries.length
      ? new Date(
          Math.max(...entries.map((row) => Date.parse(row.endsAt)))
        ).toISOString()
      : null,
    currentCovered: active.length > 0,
    note: "仅查询本地排期；provisional表示推算排期。当前无覆盖时明确未知，不能把最近历史窗口或排期到点当作实时服务端确认。",
  };
}
export function parseRules(value) {
  if (
    value?.schemaVersion !== 1 ||
    value.region !== "cn" ||
    value.source !== "rules-document-excerpts" ||
    typeof value.version !== "string" ||
    !/^cn-\d+\.\d+-dv\d+$/.test(value.version) ||
    value.macEngineVerified !== false ||
    value.evidenceTier !== "document-reference-only" ||
    !validDate(value.preparedAt) ||
    !Array.isArray(value.entries) ||
    !value.entries.length
  )
    throw Error("Invalid local rules references");
  const seen = new Set();
  for (const row of value.entries)
    if (
      typeof row.id !== "string" ||
      seen.has(row.id) ||
      typeof row.title !== "string" ||
      typeof row.body !== "string" ||
      !row.body ||
      row.body.length > 6000 ||
      !Array.isArray(row.keywords) ||
      row.keywords.some(
        (k) => typeof k !== "string" || !k.trim() || k.length > 80
      ) ||
      typeof row.sourceTitle !== "string" ||
      typeof row.sourceSection !== "string"
    )
      throw Error("Invalid rules entry");
    else seen.add(row.id);
  return value;
}
export function queryRules(query, data) {
  if (query.region !== "cn")
    return {
      status: "unsupported",
      reason: "未接国际服规则资料，不借用国服结论。",
    };
  const q = normalize(query.query),
    terms = [
      q,
      ...q
        .split(/怎么|如何|为什么|是否|能否|会不会|可以|会|的|与|和|在|是|了/)
        .filter((word) => word.length >= 2),
    ];
  const scored = data.entries
    .map((row) => ({
      row,
      score: Math.max(
        ...[row.title, ...row.keywords].map((k) => {
          const word = normalize(k);
          return word === q
            ? 100
            : q.includes(word)
            ? word.length + 10
            : terms.some(
                (term) =>
                  word.includes(term) || normalize(row.body).includes(term)
              )
            ? Math.max(
                ...terms
                  .filter(
                    (term) =>
                      word.includes(term) || normalize(row.body).includes(term)
                  )
                  .map((term) => term.length)
              )
            : 0;
        })
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
  return {
    status: scored.length ? "ok" : "not-found",
    version: data.version,
    evidenceTier: data.evidenceTier,
    macEngineVerified: false,
    sourcePreparedAt: data.preparedAt,
    entries: scored.slice(0, 3).map((r) => r.row),
    note: "仅引用已收录规则文档，不是本次客户端实测，也未运行Mac引擎，不能标为①客户端实测或②本机已验证推算。条目仅适用于其注明版本和条件；没有记录的复杂组合保持未验证。卡面文字与模型记忆不能替代结算证据。",
  };
}

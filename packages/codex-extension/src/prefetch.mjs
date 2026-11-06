import { engineCatalogMatches } from "./engine.mjs";
const normalize = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•・:：—\-_’'“”"（）()]/g, "");
function mentioned(items, text) {
  const spans = [];
  for (const item of items)
    for (const name of new Set(
      [item.name, item.englishName, item.key].filter(Boolean).map(normalize)
    )) {
      if (name.length < 2) continue;
      let at = text.indexOf(name);
      while (at >= 0) {
        spans.push({ item, start: at, end: at + name.length });
        at = text.indexOf(name, at + name.length);
      }
    }
  // Reuse the existing regional abbreviation matcher for a one-character
  // omission (for example a printed three-character name shortened to two).
  // Only unique local candidates qualify; never import aliases across regions.
  const names = new Map(items.map((item) => [item.key, item.name])),
    definitions = items.map((item) => ({ id: item.key }));
  for (const item of items) {
    const name = normalize(item.name);
    if (!/^[\u3400-\u9fff]{3,12}$/.test(name)) continue;
    for (let i = 0; i < name.length; i++) {
      const alias = name.slice(0, i) + name.slice(i + 1);
      let at = text.indexOf(alias);
      if (at < 0) continue;
      const candidates = engineCatalogMatches(definitions, alias, names).items;
      if (candidates.length !== 1 || candidates[0].id !== item.key) continue;
      while (at >= 0) {
        spans.push({ item, start: at, end: at + alias.length });
        at = text.indexOf(alias, at + alias.length);
      }
    }
  }
  return [
    ...new Map(
      spans
        .filter(
          (s) =>
            !spans.some(
              (o) =>
                o.start <= s.start &&
                o.end >= s.end &&
                o.end - o.start > s.end - s.start
            )
        )
        .map((s) => [s.item.key, s.item])
    ).values(),
  ];
}
export function prefetchPlan({
  messages,
  cards,
  locations = [],
  defaultRegion,
  engineEnabled,
  engineAutoTests,
}) {
  const text = messages.map((m) => m.text ?? "").join("\n");
  if (
    text.length > 8000 ||
    !/[?？]|请|帮|效果|几费|费用|战力|能力|机制|触发|揭示|装填|推演|模拟|验证|开局|起手|对战|技能|规则|卡组|套牌|限时|调整|OTA|更新|新卡|最新|地点/i.test(
      text
    )
  )
    return [];
  if (/国际服|全球服|global/i.test(text) && /国服|中国服/.test(text)) return [];
  const region = /国际服|全球服|global/i.test(text)
    ? "global"
    : /国服|中国服/.test(text)
    ? "cn"
    : defaultRegion;
  const found = mentioned(cards[region], normalize(text)).slice(0, 3),
    places = mentioned(locations, normalize(text)).slice(0, 2);
  const q = found.map((c) => ({ kind: "card", region, query: c.key }));
  q.push(...places.map((l) => ({ kind: "location", region, query: l.key })));
  const mechanism =
    /机制|触发|揭示|装填|推演|模拟|验证|引擎|开局|起手|对战开始|能否|能不能|会给|能给/.test(
      text
    );
  if (
    region === "cn" &&
    engineEnabled &&
    engineAutoTests &&
    mechanism &&
    (found.length || places.length)
  ) {
    q.push({ kind: "engine_status", region });
    q.push({
      kind: "rules",
      region,
      query: found
        .map((c) => c.name ?? c.key)
        .join(" ")
        .slice(0, 100),
    });
    q.push(
      ...found
        .slice(0, 2)
        .map((c) => ({ kind: "engine_catalog", region, query: c.key }))
    );
  } else if (region === "cn" && found.length === 1 && /卡组|套牌/.test(text))
    q.push({ kind: "decks", region, include: [found[0].key] });
  if (!q.length && /最新|近期|最近|新卡/.test(text) && /卡牌|新卡/.test(text))
    q.push({ kind: "recent_cards", region, limit: 5 });
  if (!q.length && /资料.*(?:版本|更新|渠道)|本地资料/.test(text))
    q.push({ kind: "data_status", region });
  return q.slice(0, 8);
}
export function compactPrefetch(results, messages) {
  const opening = /开局|装填|起手|对战开始|原始牌组/.test(
    messages.map((m) => m.text ?? "").join("\n")
  );
  const selected = [];
  let bytes = 0;
  for (let r of results) {
    if (r.query.kind === "engine_status" && r.status === "ok") {
      const {
        query,
        status,
        offline,
        version,
        evidenceTier,
        macEngineVerified,
        mechanismTests,
        inputLimitations,
        inputFormat,
        openingTests,
      } = r;
      r = {
        query,
        status,
        offline,
        version,
        evidenceTier,
        macEngineVerified,
        inputLimitations,
        ...(opening ? { openingTests } : { mechanismTests, inputFormat }),
        prefetchedFormat: opening ? "from-start" : "detached-position",
      };
    }
    const size = Buffer.byteLength(JSON.stringify(r));
    if (bytes + size > 24000) continue;
    selected.push(r);
    bytes += size;
  }
  return selected;
}

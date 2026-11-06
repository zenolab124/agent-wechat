import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9_]+$/;
export function validateDeckLookup(item) {
  if (!["cn", "global"].includes(item.region))
    throw Error("Invalid deck region");
  const allowed =
    item.kind === "decks"
      ? [
          "kind",
          "region",
          "query",
          "include",
          "exclude",
          "featured",
          "sort",
          "offset",
        ]
      : item.kind === "decode_deck"
      ? ["kind", "region", "query"]
      : ["kind", "region", "cards", "name", "imageIndex"];
  if (Object.keys(item).some((key) => !allowed.includes(key)))
    throw Error("Invalid deck lookup fields");
  if (item.kind === "decks") {
    if (
      (item.query !== undefined &&
        (typeof item.query !== "string" || item.query.length > 160)) ||
      ["include", "exclude"].some(
        (key) =>
          item[key] !== undefined &&
          (!Array.isArray(item[key]) ||
            item[key].length > 12 ||
            item[key].some(
              (q) => typeof q !== "string" || !q.trim() || q.length > 100
            ))
      ) ||
      (item.featured !== undefined && typeof item.featured !== "boolean") ||
      (item.sort !== undefined &&
        !["default", "votes", "updated", "featured_rank"].includes(
          item.sort
        )) ||
      (item.offset !== undefined &&
        (!Number.isSafeInteger(item.offset) || item.offset < 0))
    )
      throw Error("Invalid deck filters");
  } else if (item.kind === "decode_deck") {
    if (
      typeof item.query !== "string" ||
      !item.query.trim() ||
      item.query.length > 12000
    )
      throw Error("Invalid deck code");
  } else if (item.kind === "encode_image_deck") {
    if (
      !Number.isInteger(item.imageIndex) ||
      item.imageIndex < 1 ||
      item.imageIndex > 4 ||
      !Array.isArray(item.cards) ||
      item.cards.length !== 12 ||
      item.cards.some(
        (slot) =>
          !slot ||
          Object.keys(slot).some(
            (k) => !["query", "confidence", "cost", "power"].includes(k)
          ) ||
          typeof slot.query !== "string" ||
          slot.query.length > 100 ||
          !["clear", "uncertain"].includes(slot.confidence) ||
          ["cost", "power"].some(
            (k) =>
              slot[k] !== undefined &&
              (!Number.isSafeInteger(slot[k]) ||
                slot[k] < -1000 ||
                slot[k] > 1000)
          )
      ) ||
      (item.name !== undefined &&
        (typeof item.name !== "string" || item.name.length > 80))
    )
      throw Error("Invalid image deck recognition");
  } else throw Error("Invalid deck operation");
}
export const normalizeCardName = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•・:：—\-_’'“”"（）()]/g, "");
export function deckKey(ids) {
  const chunks = [];
  for (const part of ["deck-v1", ...[...ids].sort()]) {
    const bytes = Buffer.from(part);
    chunks.push(Buffer.from(String(bytes.length)), Buffer.from([0]), bytes);
  }
  return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}
export function completeDeck(ids) {
  return (
    Array.isArray(ids) &&
    ids.length === 12 &&
    ids.every(
      (id) => typeof id === "string" && ID.test(id) && id.length <= 100
    ) &&
    new Set(ids).size === 12
  );
}
export function encodeDeck(ids, name = "") {
  if (!completeDeck(ids))
    throw Error("A deck requires twelve distinct card IDs");
  return Buffer.from(
    JSON.stringify({
      Cards: ids.map((CardDefId) => ({ CardDefId })),
      Name: name.trim().slice(0, 80),
    })
  ).toString("base64");
}
export function decodeDeck(input) {
  if (typeof input !== "string" || input.length > 12000) return null;
  const candidates = input
    .trim()
    .split(/\s+/)
    .filter((row) => /^[A-Za-z0-9+/]+={0,2}$/.test(row) && row.length >= 24);
  for (const candidate of candidates)
    try {
      const bytes = Buffer.from(candidate, "base64");
      if (
        bytes.toString("base64").replace(/=+$/, "") !==
        candidate.replace(/=+$/, "")
      )
        continue;
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
      if (!Array.isArray(value?.Cards)) continue;
      const ids = value.Cards.map((card) =>
        typeof card === "string"
          ? card
          : card?.CardDefId ?? card?.cardDefId ?? card?.CardId ?? card?.cardId
      );
      if (!completeDeck(ids)) continue;
      return {
        ids,
        name:
          typeof value.Name === "string" ? value.Name.trim().slice(0, 80) : "",
        code: candidate,
      };
    } catch {
      /* Try the next line in official share text. */
    }
  return null;
}
export function issuedDeckCodes(text) {
  if (typeof text !== "string") return [];
  return [...new Set(text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? [])].filter(
    (token) => {
      try {
        const decoded = Buffer.from(token, "base64").toString("utf8");
        // Also catch a wrapped/truncated code prefix so it cannot evade the
        // final comparison merely because it is no longer valid JSON.
        if (/"(?:Cards|CardDefId)"\s*:/.test(decoded)) return true;
        return Array.isArray(JSON.parse(decoded)?.Cards);
      } catch {
        return false;
      }
    }
  );
}
export function directlyMentioned(message, ownUsername) {
  return (
    message.mentions?.state === "known" &&
    Array.isArray(message.mentions.userIds) &&
    message.mentions.userIds.includes(ownUsername)
  );
}
export function imageDeckRequest(message, ownUsername) {
  const command =
    typeof message.body === "string"
      ? message.body
          .replace(/^@.*?\u2005/, "")
          .replace(/^@\S+\s+/, "")
          .trim()
      : "";
  const shortRequest =
    /^(?:(?:转(?:成|为|换)?|生成|做成)(?:卡组|套牌)(?:代)?码|(?:卡组|套牌)转(?:成|为)?(?:代)?码)[。！!？?\s]*$/.test(
      command
    );
  return (
    directlyMentioned(message, ownUsername) &&
    typeof message.body === "string" &&
    !/(?:不要|不用|不必|无需|先不|别).{0,12}(?:转|生成|做|给|卡组码|套牌码)/.test(
      message.body
    ) &&
    (/(?:卡组|套牌|卡牌|导入)(?:代)?码|deck\s*code/i.test(message.body) ||
      shortRequest) &&
    (/(?:帮我|帮忙|请.{0,15}(?:转|生成|做|给|识别)|转成|转换|生成|做成|给我|识别)/.test(
      message.body
    ) ||
      shortRequest)
  );
}
export function resolveCard(cards, query) {
  const q = normalizeCardName(query);
  const key = cards.filter((card) => normalizeCardName(card.key) === q);
  if (key.length === 1) return key[0];
  const found = cards.filter((card) =>
    [card.name, card.englishName].some(
      (name) => name && normalizeCardName(name) === q
    )
  );
  const collectible = found.filter((card) => card.collectible);
  return collectible.length === 1
    ? collectible[0]
    : found.length === 1
    ? found[0]
    : null;
}
function resolveSearchCard(cards, query) {
  const exact = resolveCard(cards, query);
  if (exact) return exact;
  const q = normalizeCardName(query);
  if (!q) return null;
  const found = cards.filter(
    (card) =>
      card.collectible &&
      [card.key, card.name, card.englishName].some(
        (name) => name && normalizeCardName(name).includes(q)
      )
  );
  return found.length === 1 ? found[0] : null;
}
export function parseDeckLibrary(body, count) {
  if (
    body?.schemaVersion !== 1 ||
    body.region !== "cn" ||
    body.mode !== "standard" ||
    !Array.isArray(body.items) ||
    body.items.length !== count
  )
    throw Error("Invalid local deck library");
  const seen = new Set();
  for (const item of body.items) {
    if (
      item?.region !== "cn" ||
      item.status !== "collected" ||
      !completeDeck(item.card_def_ids) ||
      deckKey(item.card_def_ids) !== item.deck_key ||
      seen.has(item.deck_key) ||
      typeof item.title !== "string"
    )
      throw Error("Invalid local deck composition");
    const featured = item.ladder_featured;
    if (
      featured != null &&
      (typeof featured !== "object" ||
        typeof featured.period_id !== "string" ||
        !featured.period_id ||
        !Number.isSafeInteger(featured.rank) ||
        featured.rank < 1 ||
        !Number.isSafeInteger(featured.games_played) ||
        featured.games_played < 0 ||
        typeof featured.win_rate !== "number" ||
        !Number.isFinite(featured.win_rate) ||
        featured.win_rate < 0 ||
        featured.win_rate > 1)
    )
      throw Error("Invalid featured source statistics");
    seen.add(item.deck_key);
  }
  return body.items;
}
export function imageDeckCode(request, cards, allowed) {
  if (!allowed)
    return {
      status: "denied",
      reason: "截图转码需要当前发言人原生@助手并明确请求，且已绑定本次图片。",
    };
  const resolved = request.cards.map((slot) =>
    slot.confidence === "clear" ? resolveSearchCard(cards, slot.query) : null
  );
  const missing = resolved.flatMap((card, index) =>
    !card || !card.collectible ? [index + 1] : []
  );
  if (
    missing.length ||
    new Set(resolved.filter(Boolean).map((card) => card.key)).size !== 12
  )
    return {
      status: "needs-confirmation",
      replyText: `这张图还不能生成可靠的卡组码。${
        missing.length
          ? `第${missing.join("、")}张卡看不清或无法在本服目录中唯一核对`
          : "识别结果有重复卡牌"
      }。已收到本次@及转码请求，无需重复授权；如果复核后仍不清楚，只需补充这些位置的卡名。`,
      uncertainSlots: missing,
      recognition: request.cards.map((slot, index) => ({
        slot: index + 1,
        observed: slot,
        matched: resolved[index]
          ? { key: resolved[index].key, name: resolved[index].name }
          : null,
        // Candidates assist another visual inspection; they never authorize code generation.
        candidates: cards
          .filter((c) => c.collectible)
          .map((c) => {
            const q = normalizeCardName(slot.query),
              n = normalizeCardName(c.name);
            let score =
              q && (n.includes(q) || q.includes(n))
                ? 8
                : q
                ? [...new Set(q)].filter((x) => n.includes(x)).length
                : 0;
            if (slot.cost !== undefined && c.cost === slot.cost) score += 2;
            if (slot.power !== undefined && c.power === slot.power) score += 2;
            return { card: c, score };
          })
          .filter((c) => c.score > 0)
          .sort(
            (a, b) => b.score - a.score || a.card.key.localeCompare(b.card.key)
          )
          .slice(0, 16)
          .map(({ card: c }) => ({
            key: c.key,
            name: c.name,
            cost: c.cost,
            power: c.power,
          })),
      })),
      nextAction:
        "请先在同一张绑定图片上复核未确定位置，参考本服候选的全名、卡图和可见字形；数值只是线索，不能用数值或常见卡组替代识图。能确认则再次encode_image_deck；仍不能确认才向用户只询问剩余槽位。",
    };
  const ids = resolved.map((card) => card.key),
    name = request.name ?? "截图卡组",
    code = encodeDeck(ids, name);
  return {
    status: "ok",
    code,
    cardIds: ids,
    replyText: `${
      request.region === "cn" ? "国服" : "国际服"
    } · 已核对12张卡：\n${resolved
      .map((card, i) => `${i + 1}. ${card.name ?? card.key}`)
      .join(
        "\n"
      )}\n\n${code}\n\n复制上面的整行卡组码，在游戏收藏的卡组页面粘贴导入。`,
  };
}
export function queryDecks(request, items, cards) {
  const project = (item) => ({
    key: item.deck_key,
    title: item.title,
    cards: item.card_def_ids.map((id) => {
      const card = cards.find((row) => row.key === id);
      return {
        key: id,
        name: card?.name ?? null,
        cost: card?.cost ?? null,
        power: card?.power ?? null,
      };
    }),
    code: encodeDeck(item.card_def_ids, item.title),
    note:
      typeof item.note_preview === "string"
        ? item.note_preview.slice(0, 450)
        : null,
    votes: item.votes?.up ?? null,
    featured: item.ladder_featured
      ? {
          period_id: item.ladder_featured.period_id,
          rank: item.ladder_featured.rank,
          games_played: item.ladder_featured.games_played,
          win_rate: item.ladder_featured.win_rate,
        }
      : null,
    sourceUpdatedAt: item.source_updated_at ?? null,
  });
  if (request.kind === "decode_deck") {
    const decoded = decodeDeck(request.query);
    if (!decoded)
      return {
        status: "invalid-code",
        reason: "未识别到含12张不同卡牌的官方卡组码。",
      };
    const unknown = decoded.ids.filter(
      (id) => !cards.some((card) => card.key === id && card.collectible)
    );
    if (unknown.length)
      return {
        status: "unknown-cards",
        unknown,
        reason: "所选服区的本地目录无法核对全部卡牌，不从另一服补值。",
      };
    const matches = items
      .map((item) => ({
        item,
        shared: item.card_def_ids.filter((id) => decoded.ids.includes(id))
          .length,
      }))
      .filter((row) => row.shared >= 8)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 3);
    return {
      status: "ok",
      decoded: {
        ...decoded,
        code: encodeDeck(decoded.ids, decoded.name),
        cards: decoded.ids.map((id) => ({
          key: id,
          name: cards.find((card) => card.key === id).name,
        })),
      },
      matches: matches.map((row) => ({
        ...project(row.item),
        sharedCards: row.shared,
        exact: row.shared === 12,
      })),
    };
  }
  const include = (request.include ?? []).map((q) =>
      resolveSearchCard(cards, q)
    ),
    exclude = (request.exclude ?? []).map((q) => resolveSearchCard(cards, q));
  if ([...include, ...exclude].some((card) => !card))
    return {
      status: "needs-clarification",
      reason: "筛选卡名无法在本服唯一匹配，请给出准确名称。",
    };
  const q = normalizeCardName(request.query);
  const matched = items.filter(
    (item) =>
      (!request.featured || item.ladder_featured) &&
      include.every((card) => item.card_def_ids.includes(card.key)) &&
      !exclude.some((card) => item.card_def_ids.includes(card.key)) &&
      (!q ||
        normalizeCardName(item.title).includes(q) ||
        item.deck_key === request.query ||
        item.card_def_ids.some((id) => {
          const card = cards.find((row) => row.key === id);
          return [id, card?.name, card?.englishName].some(
            (name) => name && normalizeCardName(name).includes(q)
          );
        }))
  );
  if (request.sort === "votes")
    matched.sort((a, b) => (b.votes?.up ?? 0) - (a.votes?.up ?? 0));
  if (request.sort === "updated")
    matched.sort(
      (a, b) => (b.source_updated_at ?? 0) - (a.source_updated_at ?? 0)
    );
  if (request.sort === "featured_rank")
    matched.sort(
      (a, b) =>
        (a.ladder_featured?.rank ?? Infinity) -
        (b.ladder_featured?.rank ?? Infinity)
    );
  const offset = request.offset ?? 0;
  return {
    status: "ok",
    total: matched.length,
    offset,
    nextOffset: offset + 3 < matched.length ? offset + 3 : null,
    decks: matched.slice(offset, offset + 3).map(project),
    note: "这是国服公开收录快照。普通排序/点赞不代表胜率或强度；精选胜率、场次只表示该期来源统计。说明预览不等于完整攻略。",
  };
}

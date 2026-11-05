import test from "node:test";
import assert from "node:assert/strict";
import {
  deckKey,
  encodeDeck,
  decodeDeck,
  parseDeckLibrary,
  queryDecks,
  imageDeckCode,
  imageDeckRequest,
  issuedDeckCodes,
  validateDeckLookup,
} from "../src/decks.mjs";
const ids = Array.from({ length: 12 }, (_, i) => "Card" + i);
const cards = Array.from({ length: 14 }, (_, i) => ({
  key: "Card" + i,
  name: "卡" + i,
  englishName: "Card " + i,
  collectible: true,
  cost: 1,
  power: i,
}));
const item = (ids, title = "示例牌组") => ({
  deck_key: deckKey(ids),
  title,
  region: "cn",
  status: "collected",
  card_def_ids: ids,
  source_updated_at: 1000,
  votes: { up: 2 },
  note_preview: "来源说明",
  ladder_featured: null,
});
const request = {
  kind: "encode_image_deck",
  region: "cn",
  imageIndex: 1,
  cards: ids.map((query) => ({ query, confidence: "clear" })),
};

test("official deck codes round-trip UTF-8 names and tolerate official share comments; bad compositions are refused", () => {
  const code = encodeDeck(ids, "国服截图");
  assert.ok(issuedDeckCodes(code.slice(0,120)+'\n'+code.slice(120)).length > 0);
  assert.deepEqual(decodeDeck("# 卡组\n" + code), {
    ids,
    name: "国服截图",
    code,
  });
  assert.deepEqual(JSON.parse(Buffer.from(code, "base64").toString("utf8")), {
    Cards: ids.map((CardDefId) => ({ CardDefId })),
    Name: "国服截图",
  });
  for (const bad of [ids.slice(1), [...ids.slice(1), ids[1]]])
    assert.throws(() => encodeDeck(bad));
  assert.equal(
    decodeDeck(
      Buffer.from(JSON.stringify({ Cards: ids.slice(1) })).toString("base64")
    ),
    null
  );
  assert.equal(
    issuedDeckCodes(
      Buffer.from(JSON.stringify({ Cards: ids.slice(1) })).toString("base64")
    ).length,
    1
  );
  assert.equal(decodeDeck("x".repeat(13000)), null);
});
test("library validates region, composition keys and duplicate rows independently of titles", () => {
  const row = item(ids);
  assert.equal(
    parseDeckLibrary(
      { schemaVersion: 1, region: "cn", mode: "standard", items: [row] },
      1
    ).length,
    1
  );
  for (const rows of [
    [{ ...row, deck_key: "0".repeat(64) }],
    [{ ...row, region: "global" }],
    [row, row],
  ])
    assert.throws(() =>
      parseDeckLibrary(
        { schemaVersion: 1, region: "cn", mode: "standard", items: rows },
        rows.length
      )
    );
});
test("local deck searches support include/exclude, title, featured and per-deck codes without claiming inferred win rates", () => {
  const a = item(ids),
    b = {
      ...item([...ids.slice(1), "Card12"], "另一套"),
      votes: { up: 10 },
      ladder_featured: {
        period_id: "p1",
        rank: 2,
        games_played: 50,
        win_rate: 0.6,
      },
    };
  assert.equal(
    queryDecks({ kind: "decks", include: ["卡0"] }, [a, b], cards).total,
    1
  );
  assert.equal(
    queryDecks({ kind: "decks", exclude: ["Card0"] }, [a, b], cards).decks[0]
      .title,
    "另一套"
  );
  assert.equal(
    queryDecks(
      { kind: "decks", featured: true, sort: "featured_rank" },
      [a, b],
      cards
    ).decks[0].featured.win_rate,
    0.6
  );
  assert.equal(
    queryDecks({ kind: "decks", include: ["不存在"] }, [a, b], cards).status,
    "needs-clarification"
  );
  assert.equal(
    queryDecks({ kind: "decks", query: "示例" }, [a, b], cards).decks[0]
      .featured,
    null
  );
  assert.deepEqual(
    decodeDeck(queryDecks({ kind: "decks" }, [a], cards).decks[0].code).ids,
    ids
  );
});
test("code lookup separates an exact library match from composition similarity and refuses unknown regional IDs", () => {
  const row = item(ids),
    q = { kind: "decode_deck", query: encodeDeck(ids) };
  const result = queryDecks(q, [row], cards);
  assert.equal(result.matches[0].exact, true);
  assert.equal(result.matches[0].sharedCards, 12);
  assert.equal(queryDecks(q, [row], cards.slice(1)).status, "unknown-cards");
});
test("image conversion requires caller permission and twelve unique, clear, exact regional collectible cards", () => {
  assert.equal(imageDeckCode(request, cards, false).status, "denied");
  const ok = imageDeckCode(request, cards, true);
  assert.equal(ok.status, "ok");
  assert.deepEqual(decodeDeck(ok.code).ids, ids);
  for (const mutate of [
    (r) => {
      r.cards[0].confidence = "uncertain";
    },
    (r) => {
      r.cards[0].query = "Card";
    },
    (r) => {
      r.cards[0].query = "Card1";
    },
    (r) => {
      r.cards[0].query = "ForeignCard";
    },
  ]) {
    const r = structuredClone(request);
    mutate(r);
    const result = imageDeckCode(r, cards, true);
    assert.equal(result.status, "needs-confirmation");
    assert.ok(!result.code);
  }
  assert.equal(
    imageDeckCode(
      request,
      cards.map((c) => ({ ...c, collectible: false })),
      true
    ).status,
    "needs-confirmation"
  );
});
test("only canonical direct self mentions plus an explicit conversion request open the image operation", () => {
  const good = {
    body: "@小助手 帮我把这个做成卡组码",
    mentions: { state: "known", userIds: ["bot"], self: true, all: false },
  };
  assert.equal(imageDeckRequest(good, "bot"), true);
  for (const bad of [
    { ...good, mentions: { state: "unknown", userIds: ["bot"] } },
    { ...good, mentions: { state: "known", userIds: ["other"], self: false } },
    { ...good, mentions: { state: "known", userIds: [], all: true } },
    { ...good, body: "@小助手 哈哈" },
    { ...good, body: "@小助手 不要帮我把这张图转成卡组码" },
    { ...good, body: "@小助手 这张图转卡组码有什么用" },
    { body: "@小助手 帮我把这张图转成卡组码" },
  ])
    assert.equal(imageDeckRequest(bad, "bot"), false);
});
test("deck lookup protocol cannot inject URLs, extra fields or unbounded card slots", () => {
  validateDeckLookup(request);
  validateDeckLookup({
    kind: "decks",
    region: "cn",
    include: ["Card1"],
    featured: true,
  });
  for (const bad of [
    { ...request, imageIndex: 5 },
    { ...request, cards: request.cards.slice(1) },
    { kind: "decks", region: "cn", url: "https://attacker.test" },
    { kind: "decks", region: "cn", include: ["x".repeat(101)] },
    { kind: "decode_deck", region: "cn", query: "x".repeat(12001) },
  ])
    assert.throws(() => validateDeckLookup(bad));
});

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
  textDeckCode,
  textDeckRequest,
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

test("text lists encode only distinct collectible cards from the supplied region, with ambiguity limited to relevant slots", () => {
  const q = {
    kind: "encode_text_deck",
    region: "cn",
    cards: cards.slice(0, 12).map((c) => c.name),
    name: "我的文字卡组",
  };
  validateDeckLookup(q);
  assert.equal(textDeckCode(q, cards, false).status, "denied");
  const ok = textDeckCode(q, cards, true);
  assert.deepEqual(decodeDeck(ok.code), { ids, name: q.name, code: ok.code });
  assert.equal(ok.replyText.split("\n").filter((l) => l === ok.code).length, 1);
  assert.equal(
    textDeckCode({ ...q, cards: [...ids.slice(1), ids[1]] }, cards, true)
      .status,
    "invalid-composition"
  );
  for (const extra of [
    { key: "ForeignOnly", name: "外服专有", collectible: true },
    { key: "Token", name: "衍生", collectible: false },
  ]) {
    const supplied = extra.key === "Token" ? [...cards, extra] : cards;
    const bad = textDeckCode(
      { ...q, cards: [...ids.slice(1), extra.key] },
      supplied,
      true
    );
    assert.equal(bad.status, "needs-clarification");
    assert.equal(bad.code, undefined);
    assert.equal(bad.unresolved[0].slot, 12);
  }
  const ambiguous = [
    ...cards,
    { key: "AltA", name: "观察者甲", collectible: true },
    { key: "AltB", name: "观察者乙", collectible: true },
  ];
  const bad = textDeckCode(
    { ...q, cards: [...ids.slice(1), "观察者"] },
    ambiguous,
    true
  );
  assert.equal(bad.status, "needs-clarification");
  assert.equal(bad.unresolved[0].candidates.length, 2);
});

test("editing preserves the base, applies simultaneous changes, and can continue with the newly issued code", () => {
  const base = encodeDeck(ids, "原卡组"),
    q = {
      kind: "edit_deck",
      region: "cn",
      code: base,
      replacements: [{ from: "卡0", to: "Card12" }],
    };
  validateDeckLookup(q);
  const first = textDeckCode(q, cards, true);
  assert.equal(first.status, "ok");
  assert.deepEqual(decodeDeck(base).ids, ids);
  assert.deepEqual(decodeDeck(first.code).ids, ["Card12", ...ids.slice(1)]);
  assert.equal(decodeDeck(first.code).name, "原卡组");
  assert.ok(first.replyText.includes('卡0 → 卡12'));
  assert.ok(!first.replyText.includes('1. '));
  assert.ok(!first.replyText.includes('粘贴导入'));
  const second = textDeckCode(
    {
      ...q,
      code: first.code,
      replacements: [{ from: "Card12", to: "卡13" }],
      name: "新名字",
    },
    cards,
    true
  );
  assert.deepEqual(decodeDeck(second.code).ids, ["Card13", ...ids.slice(1)]);
  assert.equal(decodeDeck(second.code).name, "新名字");
  const swapped = textDeckCode(
    {
      ...q,
      replacements: [
        { from: "Card0", to: "Card1" },
        { from: "Card1", to: "Card0" },
      ],
    },
    cards,
    true
  );
  assert.equal(swapped.status, "ok");
  assert.deepEqual(swapped.cardIds, ["Card1", "Card0", ...ids.slice(2)]);
});

test("edits reject conflicts atomically without an output code", () => {
  const q = {
    kind: "edit_deck",
    region: "cn",
    code: encodeDeck(ids),
    replacements: [{ from: "Card0", to: "Card12" }],
  };
  const cases = [
    [{ ...q, code: "broken" }, "invalid-code"],
    [
      { ...q, code: encodeDeck([...ids.slice(1), "ForeignOnly"]) },
      "needs-clarification",
    ],
    [
      { ...q, replacements: [{ from: "Card13", to: "Card12" }] },
      "invalid-replacement",
    ],
    [
      { ...q, replacements: [{ from: "Card0", to: "Card0" }] },
      "invalid-replacement",
    ],
    [
      { ...q, replacements: [{ from: "Card0", to: "Card1" }] },
      "invalid-composition",
    ],
    [
      {
        ...q,
        replacements: [
          { from: "Card0", to: "Card12" },
          { from: "卡0", to: "Card13" },
        ],
      },
      "invalid-replacement",
    ],
    [
      {
        ...q,
        replacements: [
          { from: "Card0", to: "Card12" },
          { from: "Card1", to: "ForeignOnly" },
        ],
      },
      "needs-clarification",
    ],
  ];
  for (const [bad, status] of cases) {
    const result = textDeckCode(bad, cards, true);
    assert.equal(result.status, status);
    assert.equal(result.code, undefined);
  }
});

test("text request routing accepts lists, code edits and follow-ups without claiming unrelated recent images", () => {
  const list =
    "把" +
    cards
      .slice(0, 12)
      .map((c) => c.name)
      .join("、") +
    "生成卡组码";
  for (const body of [
    list,
    "把上一套的卡0换成卡12，给我新码",
    "补齐这套卡组并生成码",
    "给我组一套国服卡组并附码",
    encodeDeck(ids) + "\n请生成卡组码",
  ]) {
    assert.equal(textDeckRequest(body), true, body);
    assert.equal(imageDeckRequest({ body }, "bot"), false, body);
  }
  for (const body of [
    "转卡组码",
    "帮我把这张图做成卡组码",
    "这张截图把卡0换成卡1再给码",
    "把图里的卡0换成卡1再给码",
    "不要把卡0换成卡1",
    "今天换了个手机",
  ])
    assert.equal(textDeckRequest(body), false, body);
  assert.equal(
    imageDeckRequest(
      { body: "把卡0换成卡1，给我卡组码", quote: { embeddedImage: true } },
      "bot"
    ),
    true
  );
});

test("text and edit schemas reject extra fields and malformed or unbounded inputs", () => {
  const q = { kind: "encode_text_deck", region: "cn", cards: ids };
  const e = {
    kind: "edit_deck",
    region: "cn",
    code: encodeDeck(ids),
    replacements: [{ from: "Card0", to: "Card12" }],
  };
  for (const bad of [
    { ...q, cards: ids.slice(1) },
    { ...q, cards: [...ids.slice(1), ""] },
    { ...q, cards: ids.map((query) => ({ query })) },
    { ...q, imageIndex: 1 },
    { ...q, name: "a".repeat(81) },
    { ...q, region: "mixed" },
    { ...e, replacements: [] },
    {
      ...e,
      replacements: [
        { from: "Card0", to: "Card12", url: "https://example.test" },
      ],
    },
    { ...e, code: "x".repeat(12001) },
    { ...e, replacements: Array(13).fill({ from: "Card0", to: "Card12" }) },
  ])
    assert.throws(() => validateDeckLookup(bad));
});

test("official deck codes round-trip UTF-8 names and tolerate official share comments; bad compositions are refused", () => {
  const code = encodeDeck(ids, "国服截图");
  assert.ok(
    issuedDeckCodes(code.slice(0, 120) + "\n" + code.slice(120)).length > 0
  );
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
test("explicit conversion requests do not require mentions and ignore requests addressed to someone else", () => {
  const good = {
    body: "@小助手 帮我把这个做成卡组码",
    mentions: { state: "known", userIds: ["bot"], self: true, all: false },
  };
  assert.equal(imageDeckRequest(good, "bot"), true);
  for (const bad of [
    { ...good, mentions: { state: "known", userIds: ["other"], self: false } },
    { ...good, body: "@小助手 哈哈" },
    { ...good, body: "@小助手 不要帮我把这张图转成卡组码" },
    { ...good, body: "@小助手 这张图转卡组码有什么用" },
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

test("native mention with short conversion commands is accepted without extra polite words", () => {
  const base = { mentions: { state: "known", userIds: ["bot"] } };
  for (const body of [
    "@1234567\u2005转卡组码",
    "@助手 转套牌码",
    "@助手 转成卡组码",
    "@助手 卡组转代码",
  ])
    assert.equal(imageDeckRequest({ ...base, body }, "bot"), true, body);
  for (const body of [
    "@助手 不要转卡组码",
    "@助手 不用生成卡组码",
    "@助手 卡组码是什么",
  ])
    assert.equal(imageDeckRequest({ ...base, body }, "bot"), false, body);
  assert.equal(
    imageDeckRequest(
      { body: "转卡组码", mentions: { state: "known", userIds: [] } },
      "bot"
    ),
    true
  );
});

test("image printed short names resolve only when unique; unresolved slots expose regional review candidates without issuing a code", () => {
  const regional = [
    ...cards,
    { key: "Uatu", name: "乌阿图观察者", cost: 0, power: 1, collectible: true },
  ];
  const r = structuredClone(request);
  r.cards[0] = { query: "观察者", confidence: "clear", cost: 0, power: 1 };
  validateDeckLookup(r);
  assert.equal(imageDeckCode(r, regional, true).cardIds[0], "Uatu");
  r.cards[0].confidence = "uncertain";
  const pending = imageDeckCode(r, regional, true);
  assert.equal(pending.code, undefined);
  assert.deepEqual(pending.uncertainSlots, [1]);
  assert.equal(pending.recognition[0].candidates[0].key, "Uatu");
  assert.ok(pending.nextAction.includes("复核"));
  assert.equal(pending.recognition[1].matched.key, "Card1");
  regional.push({ key: "Other", name: "另一个观察者", collectible: true });
  r.cards[0].confidence = "clear";
  assert.equal(imageDeckCode(r, regional, true).status, "needs-confirmation");
  assert.throws(() =>
    validateDeckLookup({
      ...r,
      cards: r.cards.map((s) => ({ ...s, cost: "0" })),
    })
  );
});

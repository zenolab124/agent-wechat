import test from "node:test";
import assert from "node:assert/strict";
import { prefetchPlan, compactPrefetch } from "../src/prefetch.mjs";
const cards = {
  cn: [
    { key: "Sunspot", name: "太阳黑子" },
    { key: "Hulk", name: "浩克" },
    { key: "RedHulk", name: "红浩克" },
  ],
  global: [{ key: "Sunspot", name: "Sunspot" }],
};
const plan = (text, extra = {}) =>
  prefetchPlan({
    messages: [{ text }],
    cards,
    locations: [],
    defaultRegion: "cn",
    ...extra,
  });
test("prefetch uses only the chosen regional directory, longest visible names, and leaves chat and ambiguous regions alone", () => {
  assert.deepEqual(plan("国服太阳黑子现在什么效果？"), [
    { kind: "card", region: "cn", query: "Sunspot" },
  ]);
  assert.deepEqual(plan("国际服Sunspot什么效果？"), [
    { kind: "card", region: "global", query: "Sunspot" },
  ]);
  assert.deepEqual(plan("国际服太阳黑子什么效果？"), []);
  assert.deepEqual(plan("国服和国际服太阳黑子什么效果？"), []);
  assert.deepEqual(plan("今天太阳黑子天气不错"), []);
  assert.deepEqual(
    plan("红浩克什么效果？").map((q) => q.query),
    ["RedHulk"]
  );
  assert.deepEqual(
    plan("红浩克和浩克什么效果？").map((q) => q.query),
    ["Hulk", "RedHulk"]
  );
});
test("mechanism prefetch supplies only read-only formats and regional IDs, never creates a game or bypasses operator settings", () => {
  const active = plan("从开局验证太阳黑子的机制", {
    engineEnabled: true,
    engineAutoTests: true,
  });
  assert.deepEqual(
    active.map((q) => q.kind),
    ["card", "engine_status", "rules", "engine_catalog"]
  );
  assert.ok(
    !active.some((q) =>
      [
        "engine_test",
        "engine_confirm",
        "engine_prepare",
        "engine_opening_test",
      ].includes(q.kind)
    )
  );
  assert.deepEqual(
    plan("太阳黑子机制", { engineEnabled: true, engineAutoTests: false }).map(
      (q) => q.kind
    ),
    ["card"]
  );
  const format = {
    query: { kind: "engine_status" },
    status: "ok",
    offline: true,
    version: "cn-test",
    openingTests: { kind: "engine_opening_test" },
    inputFormat: { secret: "unrelated-shape" },
    mechanismTests: { kind: "engine_test" },
  };
  const compact = compactPrefetch([format], [{ text: "从开局验证" }]);
  assert.equal(compact[0].openingTests.kind, "engine_opening_test");
  assert.equal(compact[0].inputFormat, undefined);
  assert.ok(
    compactPrefetch([{ query: { kind: "card" }, data: "x".repeat(25000) }], [])
      .length === 0
  );
});

test("a unique existing regional abbreviation can preload a mechanism; ambiguous nicknames stay unresolved", () => {
  const local = { cn: [{ key: "Ironheart", name: "钢铁心" }], global: [] };
  const q = prefetchPlan({
    messages: [{ text: "铁心会给对方加战力吗？请用引擎验证" }],
    cards: local,
    defaultRegion: "cn",
    engineEnabled: true,
    engineAutoTests: true,
  });
  assert.equal(q[0].query, "Ironheart");
  assert.ok(q.some((x) => x.kind === "engine_status"));
  local.cn.push({ key: "Other", name: "铁心朋友" });
  assert.deepEqual(
    prefetchPlan({
      messages: [{ text: "铁心机制？" }],
      cards: local,
      defaultRegion: "cn",
    }),
    []
  );
});

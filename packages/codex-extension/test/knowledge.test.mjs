import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLocations,
  parseLocationSchedule,
  parseRules,
  queryLocations,
  queryRules,
  validateKnowledgeLookup,
} from "../src/knowledge.mjs";
const location = (region = "cn", patch = {}) => ({
  schemaVersion: 1,
  region,
  counts: { total: 1 },
  locations: [
    {
      defId: "Place",
      nameCn: region === "cn" ? "国服地点" : "国际服地点",
      nameOriginal: "Place",
      definitionStatus: "runtime",
      testOnly: null,
      effect: region === "cn" ? "国服效果" : null,
      effectTemplate: null,
      effectResolutionStatus: "resolved",
      firstBasePoolAt: null,
      scheduledReleaseAt: null,
      tipOriginal: null,
      ...patch,
    },
  ],
});
const rules = () => ({
  schemaVersion: 1,
  region: "cn",
  source: "rules-document-excerpts",
  version: "cn-48.18-dv0",
  macEngineVerified: false,
  evidenceTier: "document-reference-only",
  preparedAt: "2026-11-01T00:00:00Z",
  entries: [
    {
      id: "skill",
      title: "技能牌",
      keywords: ["技能", "战力属性"],
      body: "技能牌没有战力属性，不接受战力修正。",
      sourceTitle: "规则总纲",
      sourceSection: "技能牌",
    },
  ],
});

test("knowledge operations have strict local-only schemas and regions", () => {
  validateKnowledgeLookup({ kind: "location", region: "cn", query: "Place" });
  validateKnowledgeLookup({ kind: "location_schedule", region: "global" });
  for (const q of [
    { kind: "rules", region: "cn", query: "" },
    { kind: "location", region: "other", query: "x" },
    { kind: "rules", region: "cn", query: "x", url: "https://attacker.test" },
  ])
    assert.throws(() => validateKnowledgeLookup(q));
});
test("location facts remain regional; unresolved templates and non-runtime records are not promoted", () => {
  const cn = parseLocations(location(), "cn"),
    global = parseLocations(location("global"), "global");
  assert.equal(cn[0].effect, "国服效果");
  assert.equal(global[0].effect, null);
  assert.equal(global[0].name, "国际服地点");
  assert.throws(() => parseLocations(location("cn"), "global"));
  const incomplete = parseLocations(
    location("cn", {
      effect: null,
      effectTemplate: "战力+{amount}",
      definitionStatus: "localization-only",
    }),
    "cn"
  );
  assert.equal(incomplete[0].effect, null);
  assert.equal(incomplete[0].definitionStatus, "localization-only");
  assert.equal(
    queryLocations({ kind: "location", query: "国服地点" }, cn).locations[0]
      .key,
    "Place"
  );
  assert.equal(
    queryLocations({ kind: "location", query: "国服地点" }, global).status,
    "not-found"
  );
});
test("schedule windows use exact boundary times and preserve provisional and missing-current status", () => {
  const raw = {
      schemaVersion: 1,
      region: "cn",
      count: 1,
      provisional: true,
      entries: [
        {
          id: "w",
          locationId: "Place",
          kind: "hot",
          startsAt: "2026-01-01T00:00:00Z",
          endsAt: "2026-01-02T00:00:00Z",
        },
      ],
    },
    schedule = parseLocationSchedule(raw, "cn"),
    places = parseLocations(location(), "cn");
  const at = Date.parse(raw.entries[0].startsAt),
    end = Date.parse(raw.entries[0].endsAt);
  const active = queryLocations(
    { kind: "location_schedule" },
    places,
    schedule,
    at
  );
  assert.equal(active.provisional, true);
  assert.equal(active.active.length, 1);
  assert.equal(active.currentCovered, true);
  const ended = queryLocations(
    { kind: "location_schedule" },
    places,
    schedule,
    end
  );
  assert.equal(ended.currentCovered, false);
  assert.deepEqual(ended.active, []);
  assert.deepEqual(ended.upcoming, []);
  assert.equal(
    queryLocations({ kind: "location_schedule" }, places, undefined).status,
    "unavailable"
  );
  assert.throws(() =>
    parseLocationSchedule({ ...raw, region: "global" }, "cn")
  );
});
test("document rules retain version and explicitly cannot claim Mac-engine or client verification", () => {
  const data = parseRules(rules()),
    result = queryRules({ region: "cn", query: "技能牌能加战力吗" }, data);
  assert.equal(result.status, "ok");
  assert.equal(result.entries[0].title, "技能牌");
  assert.equal(result.evidenceTier, "document-reference-only");
  assert.equal(result.macEngineVerified, false);
  assert.equal(result.version, "cn-48.18-dv0");
  assert.equal(
    queryRules({ region: "global", query: "技能" }, data).status,
    "unsupported"
  );
  assert.equal(
    queryRules({ region: "cn", query: "未收录特殊组合" }, data).status,
    "not-found"
  );
  for (const patch of [
    { region: "global" },
    { macEngineVerified: true },
    { evidenceTier: "client-tested" },
  ])
    assert.throws(() => parseRules({ ...rules(), ...patch }));
});

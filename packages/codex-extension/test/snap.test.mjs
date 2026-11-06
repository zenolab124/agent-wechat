import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapLookup,
  projectCards,
  projectOta,
  recentCards,
  validateLookups,
  validateSnapConfig,
} from "../src/snap.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const snap = { defaultRegion: "cn", dataDir: "/private/offline-snap" };
const card = (key, regions) => ({
  schemaVersion: 3,
  key,
  catalogRegions: ["cn", "global"].filter((r) => regions[r]),
  regions,
});
function fixture() {
  let clock = 10000;
  const reads = [];
  const cards = [
    card("Example", {
      cn: {
        name: "样例牌",
        cost: 2,
        description: "<b>国服效果</b>",
        isCollectible: true,
        sideCardKeys: ["Token"],
      },
      global: {
        name: "Example",
        cost: 4,
        power: 9,
        description: "Global effect",
        isCollectible: true,
      },
    }),
    card("Token", { cn: { name: "样例牌", power: 1, isCollectible: false } }),
  ];
  const manifest = {
    schemaVersion: 1,
    catalogSchemaVersion: 3,
    releaseId: digest("release"),
    generatedAt: "2026-01-01T00:00:00Z",
    artifacts: {},
  };
  const files = {};
  for (const [key, value] of Object.entries({
    cards,
    variants: [],
    dictionaries: { schemaVersion: 3 },
  })) {
    const name = key + "V3-release.json";
    files[name] = JSON.stringify(value);
    manifest.artifacts[key] = {
      immutablePath: name,
      sha256: digest(files[name]),
      count: value.length,
    };
  }
  const raw = [
    {
      key: "change-a",
      card_key: "Example",
      chinese_name: "样例牌",
      change_type: "ota",
      change_date: 1000,
      expire_date: 5000,
      cost_old: "2",
      cost_new: "1",
    },
  ];
  function seal() {
    files["catalogManifestV3.json"] = JSON.stringify(manifest);
    files["ota.json"] = JSON.stringify({
      region: "cn",
      source: "snap-card-changes",
      fetchedAt: "2026-01-02T00:00:00Z",
      items: raw,
    });
    files["snapshot.json"] = JSON.stringify({
      schemaVersion: 1,
      preparedAt: "2026-01-02T00:00:00Z",
      catalogSource: "https://catalog.example.test/snap/",
      manifestSha256: digest(files["catalogManifestV3.json"]),
      ota: {
        region: "cn",
        source: "snap-card-changes",
        sha256: digest(files["ota.json"]),
        count: raw.length,
      },
    });
  }
  seal();
  const lookup = createSnapLookup({
    snap,
    now: () => clock,
    readFile: (name) => {
      reads.push(name);
      if (!(name in files)) throw Error("Missing private file");
      return Buffer.from(files[name]);
    },
  });
  return {
    lookup,
    cards,
    raw,
    manifest,
    files,
    reads,
    seal,
    clock: (v) => {
      clock = v;
    },
  };
}
const query = (region = "cn", kind = "card", name = "Example") => ({
  region,
  kind,
  ...(kind === "latest_changes" ? {} : { query: name }),
});

test("SNAP accepts only local configuration and rejects model-selected sources or malformed lookups", () => {
  validateSnapConfig(snap);
  validateLookups([query()]);
  for (const value of [
    [],
    [query("other")],
    [{ ...query(), url: "https://attacker.test" }],
    [{ kind: "sql", region: "cn", query: "x" }],
    [{ ...query(), query: "" }],
  ])
    assert.throws(() => validateLookups(value));
  for (const value of [
    { ...snap, dataDir: "relative" },
    { ...snap, catalogBaseUrl: "https://online.test/" },
    { ...snap, otaCloud: {} },
  ])
    assert.throws(() => validateSnapConfig(value));
});
test("regional projection never borrows missing fields and validates identity closure", () => {
  const f = fixture(),
    [cn] = projectCards(f.cards, "cn"),
    [global] = projectCards(f.cards, "global");
  assert.equal(cn.power, null);
  assert.equal(cn.cost, 2);
  assert.equal(cn.description, "国服效果");
  assert.equal(global.power, 9);
  assert.equal(global.description, "Global effect");
  assert.throws(() =>
    projectCards([{ ...f.cards[0], catalogRegions: ["cn"] }], "cn")
  );
  assert.throws(() => projectCards([f.cards[0], f.cards[0]], "global"));
});
test("offline lookup verifies all artifacts once, keeps same-name tokens separate and never reads other files", async () => {
  const f = fixture();
  const results = await f.lookup.lookup([
    query("cn", "card", "样例牌"),
    query("global"),
    query("cn", "card", "Token"),
  ]);
  assert.equal(new Set(f.reads).size, 6);
  assert.equal(f.reads.length, 6);
  assert.equal(results[0].cards.length, 1);
  assert.equal(results[0].cards[0].key, "Example");
  assert.equal(results[0].ambiguous, false);
  assert.equal(results[0].offline, true);
  assert.equal(results[0].cards[0].relatedCards[0].key, "Token");
  assert.equal(results[1].cards[0].description, "Global effect");
  assert.deepEqual(results[1].changes, []);
  assert.equal(results[2].cards[0].key, "Token");
  assert.equal(results[0].cards[0].cost, 2);
  assert.equal(results[0].changes[0].changes.cost.new, "1");
  assert.equal(results[0].changes[0].status, "temporary-expired");
  assert.equal(
    (await f.lookup.lookup([query("global", "card", "样例牌")]))[0].status,
    "not-found"
  );
  assert.equal(
    (await f.lookup.lookup([query("global", "changes")]))[0].status,
    "unsupported"
  );
  assert.equal(f.reads.length, 6);
  assert.ok(!f.reads.includes("cards.json"));
});
test("hash/count/manifest tampering prevents use without a network fallback", async () => {
  const bad = fixture();
  bad.files["cardsV3-release.json"] = "{}";
  assert.equal((await bad.lookup.lookup([query()]))[0].status, "unavailable");
  const count = fixture();
  count.manifest.artifacts.cards.count = 500;
  count.seal();
  assert.equal((await count.lookup.lookup([query()]))[0].status, "unavailable");
  const manifest = fixture();
  manifest.files["catalogManifestV3.json"] = "{}";
  assert.equal(
    (await manifest.lookup.lookup([query()]))[0].status,
    "unavailable"
  );
  const path = fixture();
  path.manifest.artifacts.cards.immutablePath = "../outside.json";
  path.seal();
  assert.equal((await path.lookup.lookup([query()]))[0].status, "unavailable");
  assert.ok(!path.reads.includes("../outside.json"));
});
test("OTA statuses use time boundaries and latest query excludes future batches", async () => {
  const base = {
    key: "ota",
    card_key: "Example",
    change_type: "ota",
    change_date: 1000,
  };
  for (const [extra, time, expected] of [
    [{ expire_date: 2000 }, 1999, "temporary-active"],
    [{ expire_date: 2000 }, 2000, "temporary-expired"],
    [{ expire_date: 2000, promoted_date: 1800 }, 1900, "promoted"],
    [{}, 1900, "permanent"],
    [{}, 999, "pending"],
  ])
    assert.equal(projectOta([{ ...base, ...extra }], time)[0].status, expected);
  const f = fixture();
  f.raw.push(
    { ...base, key: "future", change_date: 20000 },
    { ...base, key: "latest", change_date: 2000 }
  );
  f.seal();
  const [result] = await f.lookup.lookup([query("cn", "latest_changes")]);
  assert.deepEqual(
    result.changes.map((row) => row.key),
    ["latest"]
  );
  assert.equal(result.availableBatches.length, 2);
  f.clock(3000);
  assert.equal(
    (await f.lookup.lookup([query()]))[0].changes.find(
      (row) => row.key === "change-a"
    ).status,
    "temporary-active"
  );
});
test("invalid or missing local OTA never invents history or prevents verified card lookup", async () => {
  const f = fixture();
  f.files["ota.json"] = "{}";
  const [cardResult, latest] = await f.lookup.lookup([
    query(),
    query("cn", "latest_changes"),
  ]);
  assert.equal(cardResult.status, "ok");
  assert.equal(cardResult.otaSource.unavailable, true);
  assert.deepEqual(cardResult.changes, []);
  assert.equal(latest.status, "unavailable");
});
test("local snapshot reader rejects symlinks and works without any network client", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wx-snap-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture();
  for (const [name, bytes] of Object.entries(f.files))
    writeFileSync(join(root, name), bytes);
  const lookup = createSnapLookup({ snap: { ...snap, dataDir: root } });
  assert.equal((await lookup.lookup([query()]))[0].status, "ok");
  rmSync(join(root, "catalogManifestV3.json"));
  symlinkSync(
    join(root, "snapshot.json"),
    join(root, "catalogManifestV3.json")
  );
  assert.equal(
    (
      await createSnapLookup({ snap: { ...snap, dataDir: root } }).lookup([
        query(),
      ])
    )[0].status,
    "unavailable"
  );
});

test("missing or corrupt local deck library keeps card lookup usable and never falls back online", async () => {
  const f = fixture();
  const snapshot = JSON.parse(f.files["snapshot.json"]);
  snapshot.decks = {
    region: "cn",
    sha256: "0".repeat(64),
    count: 1,
    generatedAt: 1000,
  };
  f.files["snapshot.json"] = JSON.stringify(snapshot);
  f.files["decks.json"] = "{}";
  const [deck, card] = await f.lookup.lookup([
    { kind: "decks", region: "cn" },
    query(),
  ]);
  assert.equal(deck.status, "unavailable");
  assert.equal(deck.offline, true);
  assert.equal(card.status, "ok");
  const [denied] = await f.lookup.lookup(
    [
      {
        kind: "encode_image_deck",
        region: "cn",
        imageIndex: 1,
        cards: Array.from({ length: 12 }, () => ({
          query: "Example",
          confidence: "clear",
        })),
      },
    ],
    { imageDeckAllowed: true, imageDeckIndex: 2 }
  );
  assert.equal(denied.status, "denied");
});

test("recent cards use only known elapsed regional release dates, retain ties deterministically and exclude future/token rows", () => {
  const rows = [
    { key: "Missing", collectible: true, firstReleaseDate: null },
    { key: "Future", collectible: true, firstReleaseDate: 2000 },
    { key: "Token", collectible: false, firstReleaseDate: 950 },
    { key: "Older", collectible: true, firstReleaseDate: 100 },
    { key: "B", collectible: true, firstReleaseDate: 900 },
    { key: "A", collectible: true, firstReleaseDate: 900 },
  ];
  const result = recentCards(rows, 1000, 3);
  assert.deepEqual(
    result.cards.map((row) => row.key),
    ["A", "B", "Older"]
  );
  assert.equal(result.unknownDateCount, 1);
  validateLookups([{ kind: "recent_cards", region: "cn", limit: 1 }]);
  for (const query of [
    { kind: "recent_cards", region: "cn", limit: 0 },
    { kind: "recent_cards", region: "other" },
    { kind: "recent_cards", region: "cn", url: "https://attacker.test" },
  ])
    assert.throws(() => validateLookups([query]));
});

test("regional recent-card lookup is offline and supports global without accessing CN records", async () => {
  const f = fixture();
  const result = await f.lookup.lookup([
    { kind: "recent_cards", region: "global" },
  ]);
  assert.equal(result[0].status, "ok");
  assert.equal(result[0].offline, true);
  assert.equal(result[0].region, "global");
  assert.equal(result[0].unknownDateCount, 1);
  assert.deepEqual(result[0].cards, []);
});

test("optional knowledge integrity failure cannot borrow another region or break card facts", async () => {
  const f = fixture(),
    snapshot = JSON.parse(f.files["snapshot.json"]);
  snapshot.knowledge = {
    locations: {
      cn: {
        file: "locations-cn.json",
        sha256: "0".repeat(64),
        count: 1,
        observedAt: "2026-01-01T00:00:00Z",
      },
    },
    rules: { file: "rules-cn.json", sha256: "0".repeat(64), count: 1 },
  };
  f.files["locations-cn.json"] = "{}";
  f.files["rules-cn.json"] = "{}";
  f.files["snapshot.json"] = JSON.stringify(snapshot);
  const results = await f.lookup.lookup([
    { kind: "location", region: "cn", query: "地点" },
    { kind: "location", region: "global", query: "地点" },
    { kind: "rules", region: "cn", query: "技能" },
    query(),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["unavailable", "unavailable", "unavailable", "ok"]
  );
  assert.ok(results.every((r) => r.offline));
  const before = f.reads.length;
  const [globalRules] = await f.lookup.lookup([
    { kind: "rules", region: "global", query: "技能" },
  ]);
  assert.equal(globalRules.status, "unsupported");
  assert.equal(f.reads.length, before);
});

test('prefetch returns current verified regional card facts and refreshes time-dependent OTA status without external access',async()=>{
 const f=fixture();const results=await f.lookup.prefetch([{text:'国服样例牌现在什么效果？'}]);assert.equal(results[0].query.kind,'card');assert.equal(results[0].query.region,'cn');assert.equal(results[0].cards[0].key,'Example');assert.equal(results[0].offline,true);f.clock(2000);const active=await f.lookup.prefetch([{text:'国服样例牌现在什么效果？'}]);assert.equal(active[0].changes[0].status,'temporary-active');assert.deepEqual(await f.lookup.prefetch([{text:'国际服样例牌现在什么效果？'}]),[]);
});

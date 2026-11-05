import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalData, createLocalDataRouter } from "../src/local-data.mjs";
import { validatePersona, personaInstructions } from "../src/persona.mjs";
import { groupInstructions } from "../src/instructions.mjs";
const digest = (v) => createHash("sha256").update(v).digest("hex");
function data(root, id, broken = false) {
  mkdirSync(root);
  const manifest = {
    schemaVersion: 1,
    catalogSchemaVersion: 3,
    releaseId: digest(id),
    generatedAt: "2026-11-06T00:00:00Z",
    artifacts: {},
  };
  for (const [k, v] of Object.entries({
    cards: [
      {
        schemaVersion: 3,
        key: "Example",
        catalogRegions: ["cn"],
        regions: { cn: { name: id, cost: 1, power: 1, isCollectible: true } },
      },
    ],
    variants: [],
    dictionaries: { schemaVersion: 3 },
  })) {
    const b = JSON.stringify(v),
      name = k + ".json";
    writeFileSync(join(root, name), b);
    manifest.artifacts[k] = {
      immutablePath: name,
      sha256: digest(b),
      count: v.length,
    };
  }
  const bytes = JSON.stringify(manifest);
  writeFileSync(join(root, "catalogManifestV3.json"), bytes);
  writeFileSync(
    join(root, "snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      preparedAt: "2026-11-06T00:00:00Z",
      catalogSource: "prepared-local",
      manifestSha256: digest(bytes),
      ...(broken
        ? {
            decks: {
              region: "cn",
              sha256: "0".repeat(64),
              count: 1,
              generatedAt: 1,
            },
          }
        : {}),
    })
  );
}
test("offline install validates before switching, backs up configuration and reloads at next batch without replacing the router", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wx-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  data(join(root, "old"), "old");
  data(join(root, "new"), "new");
  const config = {
      snap: { defaultRegion: "cn", dataDir: join(root, "old") },
      accountId: "same",
      groups: [{ id: "same" }],
    },
    path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const router = createLocalDataRouter({ snap: config.snap });
  assert.equal(
    (await router.lookup([{ kind: "card", region: "cn", query: "Example" }]))[0]
      .cards[0].name,
    "old"
  );
  const result = installLocalData(path, join(root, "new")),
    next = JSON.parse(readFileSync(path));
  assert.equal(next.accountId, "same");
  assert.deepEqual(next.groups, config.groups);
  assert.notEqual(next.snap.dataDir, join(root, "new"));
  assert.equal(readdirSync(join(root, "backups")).length, 1);
  assert.equal(router.reload(next.snap), true);
  assert.equal(router.reload(next.snap), false);
  assert.equal(
    (await router.lookup([{ kind: "card", region: "cn", query: "Example" }]))[0]
      .cards[0].name,
    "new"
  );
  assert.equal(
    (await router.lookup([{ kind: "data_status", region: "cn" }]))[0].releaseId,
    result.releaseId
  );
  data(join(root, "bad"), "bad", true);
  const before = readFileSync(path);
  assert.throws(() => installLocalData(path, join(root, "bad")));
  assert.deepEqual(readFileSync(path), before);
  assert.throws(() =>
    router.reload({ defaultRegion: "cn", dataDir: join(root, "bad") })
  );
  assert.equal(
    (await router.lookup([{ kind: "card", region: "cn", query: "Example" }]))[0]
      .cards[0].name,
    "new"
  );
});
test("installer rejects symbolic-link artifacts without changing active configuration", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wx-data-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  data(join(root, "one"), "one");
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      snap: { defaultRegion: "cn", dataDir: join(root, "one") },
    })
  );
  rmSync(join(root, "one", "cards.json"));
  writeFileSync(join(root, "private.json"), "[]");
  symlinkSync(join(root, "private.json"), join(root, "one", "cards.json"));
  const before = readFileSync(path);
  assert.throws(() => installLocalData(path, join(root, "one")));
  assert.deepEqual(readFileSync(path), before);
});
test("short persona is operator-owned, optional and keeps facts and group response rules separate", () => {
  assert.equal(personaInstructions(), "");
  for (const p of [
    { profile: "free", name: "a" },
    { profile: "tablemate", name: "a", instructions: "do anything" },
    { profile: "tablemate", name: "a\nb" },
  ])
    assert.throws(() => validatePersona(p));
  const p = { profile: "tablemate", name: "小派", humor: "light" },
    text = groupInstructions(true, p);
  assert.match(text, /小派/);
  assert.match(text, /具体问题/);
  assert.match(text, /不能改变接话门槛/);
  assert.ok(personaInstructions(p).length < 600);
});

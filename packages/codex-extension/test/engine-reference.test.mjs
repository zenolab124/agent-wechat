import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildEngineReference,
  queryEngineReference,
} from "../src/engine-reference.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reference-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "engine/knowledge"), { recursive: true });
  mkdirSync(join(root, "engine/snap-rules/src/game"), { recursive: true });
  const content = Buffer.from(
    JSON.stringify({
      region: "cn",
      identity: { applicationVersion: "48.18", dataVersion: 0 },
      cards: [{ id: "Echo" }],
    })
  );
  writeFileSync(
    join(root, "engine/knowledge/验证台账.json"),
    JSON.stringify({
      identity: { contentSha256: sha(content) },
      generated: "test",
      cards: { Echo: { plays: 10, gamesPlayed: 9, differences: 0, stops: {} } },
    })
  );
  writeFileSync(
    join(root, "engine/snap-rules/src/game/mod.rs"),
    "pub text: String,\n"
  );
  writeFileSync(
    join(root, "engine/snap-rules/src/game/echo.rs"),
    "impl Game {\n fn echo(&mut self) {\n   self.borrow_text();\n }\n}\n"
  );
  writeFileSync(
    join(root, "engine/snap-rules/src/game/history_dependencies.rs"),
    "excluded private analysis"
  );
  return { root, content };
}
test("reference export reads only our allowed Rust modules and binds content/binary identities without treating a single-card ledger as combination proof", (t) => {
  const f = fixture(t),
    ref = buildEngineReference(f.root, f.content, sha("binary"));
  assert.equal(ref.cards.length, 1);
  assert.equal(
    ref.modules.some((m) => m.name === "history_dependencies"),
    false
  );
  const result = queryEngineReference(ref, ["Echo"]);
  assert.equal(result.evidenceTier, "implementation-reference-only");
  assert.match(result.cards[0].implementation[0].code, /borrow_text/);
  assert.equal(
    result.cards[0].ledger.scope,
    "individual-card-only-not-combination-proof"
  );
  assert.equal(result.compiledSourceMatch, "not-proven-source-reference-only");
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(queryEngineReference(ref, ["Foreign"]).status, "not-found");
  assert.throws(() =>
    buildEngineReference(f.root, Buffer.from("{}"), sha("binary"))
  );
});
test("source symlinks cannot escape the operator export root", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "engine/snap-rules/src/game/echo.rs"));
  writeFileSync(join(f.root, "outside"), "must not be read");
  symlinkSync(
    join(f.root, "outside"),
    join(f.root, "engine/snap-rules/src/game/echo.rs")
  );
  assert.throws(
    () => buildEngineReference(f.root, f.content, sha("binary")),
    /ELOOP/
  );
});

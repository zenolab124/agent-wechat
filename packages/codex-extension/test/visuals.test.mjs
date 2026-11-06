import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  normalizeVisual,
  prepareVisual,
  ownedImageId,
  imageDirectory,
} from "../src/visuals.mjs";
import { describeMessage, isVisualMessage } from "../src/message-content.mjs";

const png = readFileSync(
  new URL(
    "../../openclaw-extension/test/fixtures/native-model.png",
    import.meta.url
  )
);
const gif = readFileSync(
  new URL(
    "../../native-client-rust/crates/wechat-simulator/fixtures/sticker.gif",
    import.meta.url
  )
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("an unsupported native sticker source remains distinguishable without leaking its signed URL", async (t) => {
  const f = fixture(t);
  f.client.mediaAssets = async () => {
    throw Object.assign(Error("private signed URL must not escape"), {
      code: "sticker_source_not_allowed",
    });
  };
  assert.deepEqual(await prepareVisual(f.args), {
    status: "unsupported-source",
  });
});

function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), "wx-visual-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const asset = {
    id: "asset",
    accountId: "account",
    messageId: "message",
    kind: "image",
    variant: "original",
    state: "available",
    sha256: hash(png),
    byteLength: png.length,
  };
  const client = {
    mediaAssets: async () => ({ items: [asset] }),
    mediaContent: async () => ({ bytes: png }),
  };
  const args = {
    client,
    config: { accountId: "account", stateDir },
    message: { id: "message" },
  };
  return { args, asset, client, stateDir };
}

test("text emoji, ordinary images and both sticker encodings are admitted; unsupported media is filtered", () => {
  assert.equal(
    describeMessage({ type: 1, body: "😊 [微笑]" }).text,
    "😊 [微笑]"
  );
  for (const message of [
    { type: 3 },
    { type: 47 },
    { type: 49, appMessageType: 8 },
  ]) {
    assert.ok(isVisualMessage({ ...message, body: null }));
  }
  for (const message of [
    { type: 43 },
    { type: 62 },
    { type: 34 },
    { type: 49, appMessageType: 4 },
    { type: 49, appMessageType: 51 },
    { type: 49, appMessageType: 6 },
    { type: 49, appMessageType: 5 },
    { type: 49, appMessageType: 57, quote: { type: 43 } },
    { type: 1, body: "x", media: [{ kind: "video" }] },
  ])
    assert.equal(describeMessage(message), null);
});

test("verified image becomes a private content-addressed JPEG suitable for Codex", async (t) => {
  const f = fixture(t);
  let guards = 0;
  const result = await prepareVisual({
    ...f.args,
    assertCurrent: async () => guards++,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.representation, "static-image");
  const bytes = readFileSync(result.path);
  assert.equal(
    ownedImageId(result.path, imageDirectory(f.stateDir)),
    hash(bytes)
  );
  assert.equal((await sharp(bytes).metadata()).format, "jpeg");
  assert.equal(statSync(result.path).mode & 0o777, 0o600);
  assert.equal(statSync(imageDirectory(f.stateDir)).mode & 0o777, 0o700);
  assert.ok(guards >= 3);
  assert.equal(
    ownedImageId(
      "/elsewhere/" + hash(bytes) + ".jpg",
      imageDirectory(f.stateDir)
    ),
    null
  );
});

test("animation input uses one frame and bounds the model image dimensions; SVG is never decoded", async () => {
  const result = await normalizeVisual(gif, { firstFrame: true });
  assert.equal(result.representation, "first-frame");
  assert.equal((await sharp(result.bytes).metadata()).pages ?? 1, 1);
  const large = await sharp({
    create: { width: 2000, height: 1800, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const resized = await normalizeVisual(large);
  assert.equal(resized.width, 1600);
  assert.ok(resized.height <= 1600);
  await assert.rejects(
    normalizeVisual(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    /raster header/
  );
  await assert.rejects(
    normalizeVisual(Buffer.alloc(16 * 1024 * 1024 + 1)),
    /bound/
  );
});

test("foreign account/message, byte tampering and incorrect source preview hashes fail closed", async (t) => {
  for (const mutate of [
    (f) => {
      f.asset.accountId = "other";
    },
    (f) => {
      f.asset.messageId = "other";
    },
    (f) => {
      f.asset.sha256 = "0".repeat(64);
    },
    (f) => {
      f.asset.byteLength++;
    },
    (f) => {
      f.asset.preview = {
        sourceSha256: "0".repeat(64),
        sha256: hash(png),
        byteLength: png.length,
      };
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(prepareVisual(f.args), { code: "VISUAL_INTEGRITY" });
  }
});

test("native still preview is read with the verified source hash, never raw WXGF bytes", async (t) => {
  const f = fixture(t);
  const sourceHash = "1".repeat(64);
  f.asset.sha256 = sourceHash;
  f.asset.preview = {
    sourceSha256: sourceHash,
    sha256: hash(png),
    byteLength: png.length,
  };
  f.client.mediaContent = async (_account, _id, options) => {
    assert.equal(options.representation, "preview");
    return { bytes: png, sourceSha256: sourceHash };
  };
  assert.equal(
    (await prepareVisual(f.args)).representation,
    "native-still-preview"
  );
  f.client.mediaContent = async () => ({
    bytes: png,
    sourceSha256: "2".repeat(64),
  });
  await assert.rejects(prepareVisual(f.args), { code: "VISUAL_INTEGRITY" });
});

test("oversized or expired media is not fetched; uncertain transfer is submitted once and remains pending", async (t) => {
  const f = fixture(t);
  let transfers = 0;
  f.client.mediaContent = async () => {
    throw Error("must not fetch");
  };
  f.asset.byteLength = 17 * 1024 * 1024;
  assert.equal((await prepareVisual(f.args)).status, "too-large");
  f.asset.byteLength = png.length;
  f.asset.state = "expired";
  assert.equal((await prepareVisual(f.args)).status, "expired");
  f.asset.state = "pending";
  f.client.transferMedia = async () => {
    transfers++;
    throw Error("uncertain response");
  };
  assert.equal(
    (await prepareVisual({ ...f.args, waitMs: 600 })).status,
    "pending"
  );
  assert.equal(transfers, 1);
});

test("transfer readiness is observed without a second POST, and cancellation escapes rather than claiming unreadable media", async (t) => {
  const f = fixture(t);
  f.asset.state = "pending";
  let reads = 0,
    transfers = 0;
  f.client.mediaAssets = async () => {
    if (++reads > 1) f.asset.state = "available";
    return { items: [f.asset] };
  };
  f.client.transferMedia = async () => {
    transfers++;
    return { accountId: "account", kind: "download" };
  };
  assert.equal((await prepareVisual(f.args)).status, "ready");
  assert.equal(transfers, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareVisual({ ...f.args, signal: controller.signal }),
    { name: "AbortError" }
  );
});

test('verified prepared images reuse checked JPEG bytes but still check current ownership and source; tampering fails closed',async t=>{
 const f=fixture(t),cache=new Map(),timings=[];let reads=0,guards=0;f.client.mediaContent=async()=>{reads++;return{bytes:png}};
 const args={...f.args,cache,onTiming:t=>timings.push(t),assertCurrent:async()=>guards++};const first=await prepareVisual(args),before=guards,second=await prepareVisual(args);assert.equal(second.status,'ready');assert.equal(first.path,second.path);assert.equal(reads,1);assert.ok(guards>before);assert.equal(timings[1].cacheHit,true);assert.equal(timings[1].contentMs,0);
 const fs=await import('node:fs');fs.writeFileSync(second.path,'tampered');await assert.rejects(prepareVisual(args),{code:'VISUAL_INTEGRITY'});assert.equal(reads,1);
});
test('a changed asset source or a missing derived preview cannot be satisfied from the prepared-image cache',async t=>{
 const f=fixture(t),cache=new Map();const first=await prepareVisual({...f.args,cache});const fs=await import('node:fs');fs.rmSync(first.path);let reads=0;f.client.mediaContent=async()=>{reads++;return{bytes:png}};assert.equal((await prepareVisual({...f.args,cache})).status,'ready');assert.equal(reads,1);f.asset.sha256='a'.repeat(64);await assert.rejects(prepareVisual({...f.args,cache}),{code:'VISUAL_INTEGRITY'});assert.equal(reads,2);
});

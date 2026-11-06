import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  constants,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_SOURCE = 16 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const imageDirectory = (stateDir) => join(stateDir, "model-images");
export function ownedImageId(path, directory) {
  if (typeof path !== "string" || !directory) return null;
  const name = basename(path);
  return /^[a-f0-9]{64}\.jpg$/.test(name) &&
    resolve(path) === join(resolve(directory), name)
    ? name.slice(0, -4)
    : null;
}

function integrity(condition) {
  if (!condition)
    throw Object.assign(
      Error("Visual account, message or integrity check failed"),
      { code: "VISUAL_INTEGRITY" }
    );
}
function bounded(asset) {
  const size =
    asset.preview?.byteLength ?? asset.byteLength ?? asset.advertisedByteLength;
  return (
    size == null ||
    (Number.isSafeInteger(size) && size > 0 && size <= MAX_SOURCE)
  );
}
function select(assets) {
  const order = ["original", "standard", "thumbnail", "normal", "encoded"];
  return [...assets].filter(bounded).sort((a, b) => {
    const rank = (asset) => {
      const n = order.indexOf(asset.actualVariant ?? asset.variant);
      return n < 0 ? 10 : n;
    };
    return rank(a) - rank(b);
  });
}

export async function prepareVisual({
  client,
  config,
  message,
  signal,
  assertCurrent,
  waitMs = 8000,
  cache,
  onTiming,
}) {
  const began = performance.now(),
    timing = {
      checksMs: 0,
      assetsMs: 0,
      transferMs: 0,
      waitMs: 0,
      contentMs: 0,
      normalizeMs: 0,
      cacheReadMs: 0,
      writeMs: 0,
      cacheHit: false,
    };
  const timed = async (key, fn) => {
    const st = performance.now();
    try {
      return await fn();
    } finally {
      timing[key] += performance.now() - st;
    }
  };
  const localSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(waitMs)])
    : AbortSignal.timeout(waitMs);
  const guard = async () => {
    localSignal.throwIfAborted();
    await timed("checksMs", () => assertCurrent?.());
    localSignal.throwIfAborted();
  };
  const scoped = async () => {
    await guard();
    const { items } = await timed("assetsMs", () =>
      client.mediaAssets(config.accountId, message.id, localSignal)
    );
    integrity(
      Array.isArray(items) &&
        items.every(
          (item) =>
            item.accountId === config.accountId && item.messageId === message.id
        )
    );
    return items.filter((item) => ["image", "sticker"].includes(item.kind));
  };
  try {
    let assets = await scoped();
    let asset = select(assets).find((item) => item.state === "available");
    if (!asset) {
      const candidate = select(assets)[0];
      if (assets.length && !candidate) return { status: "too-large" };
      if (
        candidate &&
        ["expired", "unsupported", "recalled", "failed"].includes(
          candidate.state
        )
      )
        return { status: candidate.state };
      // One transfer admission only. Waiting observes its existing result; it
      // never resubmits a possibly accepted transfer after a timeout.
      if (!candidate?.jobId) {
        await guard();
        try {
          const job = await timed("transferMs", () =>
            client.transferMedia(
              config.accountId,
              {
                messageId: message.id,
                assetId: candidate?.id ?? null,
                quality: candidate?.variant ?? "best",
              },
              localSignal
            )
          );
          integrity(
            job.accountId === config.accountId && job.kind === "download"
          );
        } catch (error) {
          if (error.code === "VISUAL_INTEGRITY") throw error;
          signal?.throwIfAborted();
        }
      }
      while (!localSignal.aborted) {
        await timed("waitMs", () =>
          delay(250, undefined, { signal: localSignal })
        );
        assets = await scoped();
        asset = select(assets).find((item) => item.state === "available");
        if (asset) break;
        if (
          assets.length &&
          assets.every((item) =>
            ["expired", "unsupported", "recalled", "failed"].includes(
              item.state
            )
          )
        )
          return { status: "unavailable" };
      }
    }
    if (!asset) return { status: "pending" };
    integrity(validHash(asset.sha256));
    const preview = asset.preview;
    if (preview)
      integrity(
        preview.sourceSha256 === asset.sha256 &&
          validHash(preview.sha256) &&
          Number.isSafeInteger(preview.byteLength) &&
          preview.byteLength > 0 &&
          preview.byteLength <= MAX_SOURCE
      );
    const cacheKey = JSON.stringify([
      config.stateDir,
      config.accountId,
      message.threadId ?? null,
      asset.sha256,
      asset.byteLength,
      preview?.sha256 ?? null,
      preview?.byteLength ?? null,
      (asset.animationFrames ?? 1) > 1,
    ]);
    const cached = cache?.get(cacheKey);
    if (cached) {
      try {
        await timed("cacheReadMs", async () => {
          integrity(
            !!ownedImageId(cached.path, imageDirectory(config.stateDir))
          );
          const fd = openSync(
            cached.path,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
          );
          try {
            const stat = fstatSync(fd);
            integrity(
              stat.isFile() &&
                stat.size === cached.byteLength &&
                stat.size <= MAX_IMAGE
            );
            integrity(hash(readFileSync(fd)) === cached.sha256);
          } finally {
            closeSync(fd);
          }
        });
        await guard();
        timing.cacheHit = true;
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return {
          status: "ready",
          path: cached.path,
          width: cached.width,
          height: cached.height,
          representation: cached.representation,
        };
      } catch (error) {
        cache.delete(cacheKey);
        if(error.name === "AbortError" || error.name === "TimeoutError")throw error;
        if (error.code !== "ENOENT")
          throw Object.assign(error, { code: "VISUAL_INTEGRITY" });
      }
    }
    await guard();
    const content = await timed("contentMs", () =>
      client.mediaContent(config.accountId, asset.id, {
        maxBytes: MAX_SOURCE,
        ...(preview ? { representation: "preview" } : {}),
        signal: localSignal,
      })
    );
    integrity(
      content.bytes.length > 0 &&
        content.bytes.length <= MAX_SOURCE &&
        hash(content.bytes) === (preview?.sha256 ?? asset.sha256) &&
        (preview
          ? content.bytes.length === preview.byteLength &&
            content.sourceSha256 === asset.sha256
          : Number.isSafeInteger(asset.byteLength) &&
            content.bytes.length === asset.byteLength)
    );
    await guard();
    const converted = await timed("normalizeMs", () =>
      normalizeVisual(content.bytes, {
        firstFrame: (asset.animationFrames ?? 1) > 1,
        preview: !!preview,
      })
    );
    await guard();
    const directory = imageDirectory(config.stateDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const digest = hash(converted.bytes);
    const path = join(directory, `${digest}.jpg`);
    const temporary = join(directory, `.${randomUUID()}`);
    await timed("writeMs", async () => {
      writeFileSync(temporary, converted.bytes, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    });
    if (cache) {
      cache.set(cacheKey, {
        path,
        width: converted.width,
        height: converted.height,
        representation: converted.representation,
        sha256: digest,
        byteLength: converted.bytes.length,
      });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    return {
      status: "ready",
      path,
      width: converted.width,
      height: converted.height,
      representation: converted.representation,
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === "VISUAL_INTEGRITY") throw error;
    if (error.code === "sticker_source_not_allowed")
      return { status: "unsupported-source" };
    return { status: localSignal.aborted ? "pending" : "unavailable" };
  } finally {
    try {
      onTiming?.({
        ...Object.fromEntries(
          Object.entries(timing).map(([key, value]) => [
            key,
            typeof value === "number" ? Math.round(value) : value,
          ])
        ),
        totalMs: Math.round(performance.now() - began),
      });
    } catch {}
  }
}

export async function normalizeVisual(
  bytes,
  { firstFrame = false, preview = false } = {}
) {
  if (!bytes.length || bytes.length > MAX_SOURCE)
    throw Error("Visual source exceeds its bound");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raster =
    (b[0] === 0xff && b[1] === 0xd8) ||
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii")) ||
    (b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP") ||
    ["II*\0", "MM\0*", "II+\0", "MM\0+"].includes(
      b.subarray(0, 4).toString("latin1")
    ) ||
    b.subarray(4, 8).toString("ascii") === "ftyp";
  if (!raster) throw Error("Unsupported raster header");
  const image = sharp(bytes, {
    pages: 1,
    animated: false,
    limitInputPixels: 24000000,
  });
  const metadata = await image.metadata();
  if (
    !["jpeg", "png", "gif", "webp", "avif", "heif", "tiff"].includes(
      metadata.format
    )
  )
    throw Error("Unsupported raster image");
  const converted = await image
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  if (converted.data.length > MAX_IMAGE)
    throw Error("Model image exceeds its bound");
  return {
    bytes: converted.data,
    width: converted.info.width,
    height: converted.info.height,
    representation: preview
      ? "native-still-preview"
      : firstFrame || (metadata.pages ?? 1) > 1
      ? "first-frame"
      : "static-image",
  };
}

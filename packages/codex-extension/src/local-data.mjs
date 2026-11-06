import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  constants,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSnapLookup } from "./snap.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const jsonName = /^[A-Za-z0-9_-]+\.json$/;
function file(root, name) {
  if (!jsonName.test(name)) throw Error("Invalid offline artifact name");
  const fd = openSync(
    join(root, name),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw Error("Invalid offline artifact");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
// This operator-only entry point accepts prepared files, never a download URL or
// database connection. The running worker keeps reading immutable directories.
export function installLocalData(configPath, candidateDirectory) {
  const path = resolve(configPath),
    original = readFileSync(path),
    config = JSON.parse(original),
    source = resolve(candidateDirectory);
  const snapshot = JSON.parse(file(source, "snapshot.json")),
    manifest = JSON.parse(file(source, "catalogManifestV3.json"));
  const names = new Set([
    "snapshot.json",
    "catalogManifestV3.json",
    ...["cards", "variants", "dictionaries"].map(
      (k) => manifest.artifacts?.[k]?.immutablePath
    ),
    ...(snapshot.ota ? ["ota.json"] : []),
    ...(snapshot.decks ? ["decks.json"] : []),
  ]);
  for (const kind of ["locations", "schedules"])
    for (const region of ["cn", "global"]) {
      const ref = snapshot.knowledge?.[kind]?.[region];
      if (ref) names.add(ref.file);
    }
  if (snapshot.knowledge?.rules) names.add(snapshot.knowledge.rules.file);
  const base = join(dirname(path), "snap-data"),
    id = "installed-" + Date.now() + "-" + randomUUID().slice(0, 8),
    target = join(base, id);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  let temp,
    committed = false;
  try {
    for (const name of names)
      writeFileSync(
        join(target, jsonName.test(name) ? name : "invalid"),
        file(source, name),
        { mode: 0o600, flag: "wx" }
      );
    const snap = { ...config.snap, dataDir: target };
    const status = createSnapLookup({ snap }).inspect({ strict: true });
    // A bad candidate cannot silently remove a capability already installed.
    const previous = config.snap
      ? createSnapLookup({ snap: config.snap }).inspect({ strict: true })
      : null;
    if (
      previous &&
      ((previous.ota && !status.ota) ||
        (previous.decks && !status.decks) ||
        (previous.knowledge.rules && !status.knowledge.rules) ||
        ["cn", "global"].some((r) =>
          ["locations", "schedules"].some(
            (k) => previous.knowledge[k][r] && !status.knowledge[k][r]
          )
        ))
    )
      throw Error("Local update would remove installed data");
    if (!readFileSync(path).equals(original))
      throw Error("Configuration changed while installing");
    const backupRoot = join(dirname(path), "backups");
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(backupRoot, id + ".config.json"), original, {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(
      join(target, "installation.json"),
      JSON.stringify({
        schemaVersion: 1,
        installedAt: new Date().toISOString(),
        previousDataDir: config.snap?.dataDir ?? null,
        previousConfigSha256: hash(original),
        status,
      }),
      { mode: 0o600, flag: "wx" }
    );
    temp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ...config, snap }, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    temp = null;
    committed = true;
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return {
      status: "installed",
      dataDir: target,
      previousDataDir: config.snap?.dataDir ?? null,
      ...status,
    };
  } catch (error) {
    if (temp) rmSync(temp, { force: true });
    if (!committed) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
// Called only at a worker loop boundary, never between phases of one answer.
// A failed update leaves the last validated directory in use.
export function createLocalDataRouter(options) {
  let current = createSnapLookup(options),
    active = JSON.stringify(options.snap);
  return {
    get defaultRegion() {
      return current.defaultRegion;
    },
    get engineAutoTests() {
      return current.engineAutoTests;
    },
    get engineEnabled() {
      return current.engineEnabled;
    },
    lookup: (...args) => current.lookup(...args),
    prefetch: (...args) => current.prefetch(...args),
    inspect: (...args) => current.inspect(...args),
    reload(snap) {
      const next = JSON.stringify(snap);
      if (next === active) return false;
      if (snap.defaultRegion !== current.defaultRegion)
        throw Error("Region changes require worker restart");
      const candidate = createSnapLookup({ ...options, snap });
      candidate.inspect({ strict: true });
      current = candidate;
      active = next;
      return true;
    },
  };
}

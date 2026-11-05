import { createHash } from "node:crypto";
import {
  openSync,
  readFileSync,
  fstatSync,
  closeSync,
  constants,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  validateDeckLookup,
  parseDeckLibrary,
  imageDeckCode,
  queryDecks,
} from "./decks.mjs";

const LIMIT = 32 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value) =>
  typeof value === "string"
    ? value
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim()
    : null;
const normalize = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•・:：—\-_’'“”"（）()]/g, "");
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function validateSnapConfig(snap) {
  if (snap === undefined) return;
  if (
    !snap ||
    typeof snap !== "object" ||
    !["cn", "global"].includes(snap.defaultRegion) ||
    typeof snap.dataDir !== "string" ||
    !isAbsolute(snap.dataDir) ||
    Object.keys(snap).some((key) => !["defaultRegion", "dataDir"].includes(key))
  )
    throw Error("SNAP requires a local-only data directory and region");
}

export function validateLookups(value) {
  if (!Array.isArray(value) || !value.length || value.length > 8)
    throw Error("Invalid SNAP lookup batch");
  for (const item of value) {
    if (
      item &&
      ["decks", "decode_deck", "encode_image_deck"].includes(item.kind)
    ) {
      validateDeckLookup(item);
      continue;
    }
    if (
      !item ||
      Object.keys(item).some(
        (key) => !["kind", "region", "query"].includes(key)
      ) ||
      !["card", "changes", "latest_changes"].includes(item.kind) ||
      !["cn", "global"].includes(item.region) ||
      (item.kind !== "latest_changes" &&
        (typeof item.query !== "string" ||
          !item.query.trim() ||
          item.query.length > 160)) ||
      (item.query !== undefined && typeof item.query !== "string")
    )
      throw Error("Invalid SNAP lookup");
  }
  return value;
}

export function projectCards(records, region) {
  if (!Array.isArray(records) || !["cn", "global"].includes(region))
    throw Error("Invalid regional catalog");
  const seen = new Set();
  const cards = [];
  for (const row of records) {
    if (
      row?.schemaVersion !== 3 ||
      typeof row.key !== "string" ||
      !row.key ||
      seen.has(row.key) ||
      !row.regions ||
      !Array.isArray(row.catalogRegions) ||
      JSON.stringify(row.catalogRegions) !==
        JSON.stringify(
          ["cn", "global"].filter((key) => row.regions[key] !== undefined)
        )
    )
      throw Error("Invalid catalog record");
    seen.add(row.key);
    const data = row.regions[region];
    if (!data) continue;
    cards.push({
      key: row.key,
      region,
      name: text(data.name),
      englishName: text(data.englishName),
      cost: number(data.cost),
      power: number(data.power),
      description: text(data.description),
      series: number(data.series),
      firstReleaseDate: number(data.firstReleaseDate),
      collectible: data.isCollectible === true,
      sideCardKeys: Array.isArray(data.sideCardKeys)
        ? data.sideCardKeys.filter((key) => typeof key === "string")
        : [],
    });
  }
  return cards;
}

export function otaStatus(row, now = Date.now()) {
  if (row.change_date > now) return "pending";
  if (row.promoted_date && row.promoted_date <= now) return "promoted";
  if (!row.expire_date) return "permanent";
  return now < row.expire_date ? "temporary-active" : "temporary-expired";
}

export function projectOta(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw Error("Invalid OTA records");
  return rows
    .map((row) => {
      if (
        typeof row.key !== "string" ||
        !row.key ||
        typeof row.card_key !== "string" ||
        !row.card_key ||
        row.change_type !== "ota" ||
        !Number.isSafeInteger(row.change_date) ||
        row.change_date <= 0 ||
        ["expire_date", "promoted_date"].some(
          (key) =>
            row[key] != null &&
            (!Number.isSafeInteger(row[key]) || row[key] <= 0)
        )
      )
        throw Error("Invalid OTA record");
      return {
        key: row.key,
        cardKey: row.card_key,
        region: "cn",
        name: text(row.chinese_name),
        date: row.change_date,
        expiresAt: row.expire_date ?? null,
        promotedAt: row.promoted_date ?? null,
        status: otaStatus(row, now),
        changes: Object.fromEntries(
          ["cost", "power", "chinese_description"].flatMap((field) => {
            const old = row[field + "_old"];
            const next = row[field + "_new"];
            return old == null && next == null
              ? []
              : [
                  [
                    field === "chinese_description" ? "description" : field,
                    { old: text(old), new: text(next) },
                  ],
                ];
          })
        ),
        remark: text(row.remark),
      };
    })
    .sort((a, b) => b.date - a.date || a.key.localeCompare(b.key));
}

function matches(cards, query) {
  const q = normalize(query);
  const byKey = cards.filter((row) => normalize(row.key) === q);
  if (byKey.length) return byKey;
  const exact = cards.filter((row) =>
    [row.key, row.name, row.englishName].some(
      (name) => name && normalize(name) === q
    )
  );
  const collectible = exact.filter((row) => row.collectible);
  return exact.length
    ? collectible.length === 1
      ? collectible
      : exact
    : cards.filter((row) =>
        [row.key, row.name, row.englishName].some(
          (name) => name && normalize(name).includes(q)
        )
      );
}

function localBytes(directory, name) {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
    throw Error("Invalid local SNAP artifact");
  const fd = openSync(
    join(directory, name),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMIT)
      throw Error("Invalid local SNAP file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// No database SDK, child process or network client is available on this path.
// A separate preparation step installs an immutable local data package.
export function createSnapLookup({
  snap,
  now = Date.now,
  readFile = (name) => localBytes(snap.dataDir, name),
} = {}) {
  validateSnapConfig(snap);
  let catalog, ota, decks, deckSource;
  function load() {
    if (catalog) return catalog;
    const snapshot = JSON.parse(readFile("snapshot.json"));
    if (
      snapshot.schemaVersion !== 1 ||
      !Number.isFinite(Date.parse(snapshot.preparedAt)) ||
      !sha(snapshot.manifestSha256)
    )
      throw Error("Invalid local SNAP snapshot");
    const manifestBytes = readFile("catalogManifestV3.json");
    if (hash(manifestBytes) !== snapshot.manifestSha256)
      throw Error("Local manifest integrity failed");
    const manifest = JSON.parse(manifestBytes);
    if (
      manifest.schemaVersion !== 1 ||
      manifest.catalogSchemaVersion !== 3 ||
      !sha(manifest.releaseId) ||
      !Number.isFinite(Date.parse(manifest.generatedAt))
    )
      throw Error("Invalid manifest");
    const data = ["cards", "variants", "dictionaries"].map((name) => {
      const ref = manifest.artifacts?.[name];
      if (
        !sha(ref?.sha256) ||
        !/^[a-zA-Z0-9_-]+\.json$/.test(ref?.immutablePath ?? "")
      )
        throw Error("Invalid artifact");
      const bytes = readFile(ref.immutablePath);
      if (hash(bytes) !== ref.sha256) throw Error("Catalog integrity failed");
      const value = JSON.parse(bytes);
      if (
        name !== "dictionaries" &&
        (!Array.isArray(value) || value.length !== ref.count)
      )
        throw Error("Catalog count mismatch");
      return value;
    });
    if (data[2]?.schemaVersion !== 3) throw Error("Invalid dictionaries");
    const cn = projectCards(data[0], "cn"),
      global = projectCards(data[0], "global");
    projectCards(data[1], "cn");
    const keys = new Set(data[0].map((row) => row.key));
    for (const row of data[1])
      if (!keys.has(row.cardKey)) throw Error("Invalid variant binding");
    let loadedOta;
    try {
      if (
        snapshot.ota?.region !== "cn" ||
        snapshot.ota?.source !== "snap-card-changes" ||
        !sha(snapshot.ota.sha256)
      )
        throw Error("Invalid local OTA reference");
      const bytes = readFile("ota.json");
      if (hash(bytes) !== snapshot.ota.sha256)
        throw Error("OTA integrity failed");
      const value = JSON.parse(bytes);
      if (
        value.region !== "cn" ||
        value.source !== "snap-card-changes" ||
        !Number.isFinite(Date.parse(value.fetchedAt)) ||
        value.items?.length !== snapshot.ota.count
      )
        throw Error("Invalid local OTA snapshot");
      projectOta(value.items, now());
      loadedOta = value;
    } catch {
      loadedOta = undefined;
    }
    ota = loadedOta;
    if (snapshot.decks) {
      try {
        if (
          snapshot.decks.region !== "cn" ||
          !sha(snapshot.decks.sha256) ||
          !Number.isSafeInteger(snapshot.decks.generatedAt)
        )
          throw Error("Invalid local decks reference");
        const bytes = readFile("decks.json");
        if (hash(bytes) !== snapshot.decks.sha256)
          throw Error("Local decks integrity failed");
        decks = parseDeckLibrary(JSON.parse(bytes), snapshot.decks.count);
        deckSource = {
          region: "cn",
          generatedAt: snapshot.decks.generatedAt,
          count: decks.length,
          sha256: snapshot.decks.sha256,
          offline: true,
        };
      } catch {
        decks = undefined;
      }
    }
    catalog = {
      releaseId: manifest.releaseId,
      generatedAt: manifest.generatedAt,
      preparedAt: snapshot.preparedAt,
      source: snapshot.catalogSource,
      cards: { cn, global },
    };
    return catalog;
  }
  return {
    defaultRegion: snap.defaultRegion,
    async lookup(requests, { imageDeckAllowed = false, imageDeckIndex } = {}) {
      validateLookups(requests);
      return requests.map((query) => {
        try {
          if (
            query.region === "global" &&
            !["card", "encode_image_deck", "decode_deck"].includes(query.kind)
          )
            return {
              query,
              status: "unsupported",
              reason: "未接入该项国际服离线资料，不借用国服记录。",
            };
          const source = load(),
            regional = source.cards[query.region];
          const metadata = {
            region: query.region,
            releaseId: source.releaseId,
            catalogGeneratedAt: source.generatedAt,
            preparedAt: source.preparedAt,
            catalogSource: source.source,
            offline: true,
          };
          if (query.kind === "encode_image_deck")
            return {
              query,
              ...metadata,
              ...imageDeckCode(
                query,
                regional,
                imageDeckAllowed && query.imageIndex === imageDeckIndex
              ),
            };
          if (query.kind === "decks" || query.kind === "decode_deck") {
            if (query.kind === "decks" && !decks)
              return {
                query,
                ...metadata,
                status: "unavailable",
                reason: "本机国服卡组库缺失或校验失败，不联网补值。",
              };
            return {
              query,
              ...metadata,
              ...(query.region === "cn" ? { deckSource } : {}),
              ...queryDecks(
                query,
                query.region === "cn" ? decks ?? [] : [],
                regional
              ),
            };
          }
          const records =
            query.region === "cn" && ota ? projectOta(ota.items, now()) : [];
          const otaMeta =
            query.region === "cn"
              ? ota
                ? {
                    source: ota.source,
                    fetchedAt: ota.fetchedAt,
                    offline: true,
                  }
                : { unavailable: true }
              : undefined;
          if (query.kind === "latest_changes") {
            if (!ota)
              return {
                query,
                status: "unavailable",
                reason: "本机缺少可校验的国服 OTA 记录，不能确认最近调整。",
                ...metadata,
              };
            const dates = [
              ...new Set(
                records
                  .filter((row) => row.date <= now())
                  .map((row) => row.date)
              ),
            ].slice(0, 3);
            return {
              query,
              status: "ok",
              ...metadata,
              otaSource: otaMeta,
              availableBatches: dates.map((date) => ({
                date,
                count: records.filter((row) => row.date === date).length,
              })),
              changes: records
                .filter((row) => row.date === dates[0])
                .slice(0, 100),
            };
          }
          const found = matches(regional, query.query);
          if (!found.length)
            return {
              query,
              status: "not-found",
              ...metadata,
              reason: "本服本地目录无匹配；不得从另一服补值。",
            };
          const cards = found.slice(0, 8);
          return {
            query,
            status: "ok",
            ...metadata,
            ambiguous: found.length > 1,
            truncated: found.length > cards.length,
            cards: cards.map((card) => ({
              ...card,
              relatedCards: card.sideCardKeys
                .map((key) => regional.find((row) => row.key === key))
                .filter(Boolean)
                .slice(0, 8),
            })),
            otaSource: otaMeta,
            changes: records
              .filter((row) => cards.some((card) => row.cardKey === card.key))
              .slice(0, 30),
            note: "资料全部来自本机离线快照，仅覆盖标示的生成/导出时间；不代表实时客户端或最新公告。历史、限时、过期、待生效值不能直接冒充当前效果。",
          };
        } catch {
          return {
            query,
            status: "unavailable",
            offline: true,
            reason:
              "本机 SNAP 资料缺失或校验失败，不能确认数据；不会联网或查询数据库补值。",
          };
        }
      });
    },
  };
}

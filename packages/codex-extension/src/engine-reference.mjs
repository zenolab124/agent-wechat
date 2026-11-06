import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readdirSync,
  constants,
} from "node:fs";
import { join } from "node:path";
const hash = (b) => createHash("sha256").update(b).digest("hex");
function read(path, max = 2 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw Error("Invalid reference file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function functions(module, code) {
  const lines = code.split("\n"),
    starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m =
      /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(/.exec(
        lines[i]
      );
    if (m) starts.push({ at: i, indent: m[1].length, name: m[2] });
  }
  return starts.map((f, i) => {
    const end =
      starts.slice(i + 1).find((x) => x.indent <= f.indent)?.at ?? lines.length;
    return {
      module,
      symbol: f.name,
      line: f.at + 1,
      partial: end - f.at > 85,
      code: lines
        .slice(f.at, Math.min(end, f.at + 85))
        .join("\n")
        .slice(0, 6500),
    };
  });
}
// Maintenance-only export of our Rust implementation, never client code or
// arbitrary files requested by the model. Paths are not included in the bundle.
export function buildEngineReference(sourceRoot, contentBytes, binarySha256) {
  if (typeof binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(binarySha256))
    throw Error("Expected installed binary identity");
  const content = JSON.parse(contentBytes),
    ledger = JSON.parse(
      read(join(sourceRoot, "engine/knowledge/验证台账.json"))
    );
  if (
    content.region !== "cn" ||
    ledger.identity?.contentSha256 !== hash(contentBytes)
  )
    throw Error("Reference content mismatch");
  const directory = join(sourceRoot, "engine/snap-rules/src/game"),
    modules = [];
  for (const file of readdirSync(directory).filter(
    (f) => /^[a-z_]+\.rs$/.test(f) && f !== "history_dependencies.rs"
  )) {
    const bytes = read(join(directory, file));
    modules.push({
      name: file.slice(0, -3),
      sha256: hash(bytes),
      code: bytes.toString("utf8"),
    });
  }
  const symbols = modules.flatMap((m) => functions(m.name, m.code));
  const cards = content.cards.map((card) => {
    const stem = card.id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const own = symbols.filter(
      (s) => s.symbol === stem || s.symbol.startsWith(stem + "_")
    );
    const dispatch = [];
    const helpers = new Set();
    const token = new RegExp("\\bBehavior::" + card.id + "\\b");
    for (const m of modules) {
      const lines = m.code.split("\n");
      for (let i = 0; i < lines.length; i++)
        if (token.test(lines[i])) {
          dispatch.push({
            module: m.name,
            line: i + 1,
            code: lines
              .slice(Math.max(0, i - 1), Math.min(lines.length, i + 3))
              .join("\n")
              .slice(0, 2500),
          });
          for (const match of lines[i].matchAll(/(?:self|game)\.(\w+)\(/g))
            if (
              !["update_ongoing", "activate_reveal", "run_trigger"].includes(
                match[1]
              )
            )
              helpers.add(match[1]);
        }
    }
    const supporting = own.length
      ? []
      : symbols.filter((s) => helpers.has(s.symbol)).slice(0, 2);
    const entry = ledger.cards?.[card.id];
    return {
      id: card.id,
      implementation: [...own, ...supporting]
        .slice(0, 4)
        .map(({ module, symbol }) => ({ module, symbol })),
      dispatch: dispatch.slice(0, 3),
      ledger: entry
        ? {
            plays: entry.plays,
            gamesPlayed: entry.gamesPlayed,
            differences: entry.differences,
            stops: entry.stops,
          }
        : null,
    };
  });
  const cardModule = modules.find((m) => m.name === "mod");
  const fieldLines = cardModule?.code.split("\n") ?? [];
  const fields = [];
  for (let i = 0; i < fieldLines.length; i++)
    if (
      /pub (?:galacti_picks|shots_loaded|shots_used|shot_tokens|starting_deck_of|text|definition|behavior):/.test(
        fieldLines[i]
      )
    )
      fields.push(fieldLines.slice(Math.max(0, i - 1), i + 1).join("\n"));
  return {
    schema: "snap-engine-reference/v1",
    region: "cn",
    version: `cn-${content.identity.applicationVersion}-dv${content.identity.dataVersion}`,
    contentSha256: hash(contentBytes),
    binarySha256,
    compiledSourceMatch: "not-proven-source-reference-only",
    generatedAt: new Date().toISOString(),
    ledgerGeneratedAt: ledger.generated,
    source: "local-rust-implementation-reference",
    modules: modules.map(({ name, sha256 }) => ({ name, sha256 })),
    fields,
    symbols,
    cards,
  };
}
export function queryEngineReference(bundle, ids) {
  const selected = ids.map((id) => bundle.cards.find((c) => c.id === id));
  if (selected.some((c) => !c))
    return {
      status: "not-found",
      reason: "本地实现参考没有该牌，不能据此认定能力未实现。",
    };
  let remaining = 17000;
  const cards = selected.map((c) => {
    const implementation = [];
    for (const ref of c.implementation) {
      const s = bundle.symbols.find(
        (s) => s.module === ref.module && s.symbol === ref.symbol
      );
      if (!s) continue;
      if (remaining <= 0) break;
      const code = s.code.slice(0, Math.min(4500, remaining));
      remaining -= code.length;
      implementation.push({
        ...s,
        code,
        partial: s.partial || code.length < s.code.length,
      });
    }
    return {
      ...c,
      implementation,
      dispatch: c.dispatch.slice(0, 2),
      ledger: {
        ...c.ledger,
        scope: "individual-card-only-not-combination-proof",
      },
    };
  });
  return {
    status: "ok",
    offline: true,
    evidenceTier: "implementation-reference-only",
    version: bundle.version,
    source: bundle.source,
    compiledSourceMatch: bundle.compiledSourceMatch,
    generatedAt: bundle.generatedAt,
    ledgerGeneratedAt: bundle.ledgerGeneratedAt,
    cards,
    fields: bundle.fields,
    note: "只作内部回答依据：这是本地Rust实现参考，不是客户端实测或官方设计声明。单卡台账不证明当前组合。结合实际对照和触发证据解释；群内仅用中文牌名、时点、目标和效果浅显说明，不展示源码、字段名、版本号、任务号或报告。",
  };
}

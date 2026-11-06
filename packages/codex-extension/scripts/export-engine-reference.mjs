import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { buildEngineReference } from "../src/engine-reference.mjs";
const [source, content, binary, output] = process.argv.slice(2);
if (
  ![source, content, binary, output].every(
    (p) => typeof p === "string" && isAbsolute(p)
  )
)
  throw Error(
    "Provide absolute source root, content file, installed binary and new private output file"
  );
const reference = buildEngineReference(
    source,
    readFileSync(content),
    createHash("sha256").update(readFileSync(binary)).digest("hex")
  ),
  bytes = Buffer.from(JSON.stringify(reference));
if (bytes.length > 4 * 1024 * 1024) throw Error("Reference exceeds bound");
writeFileSync(output, bytes, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    version: reference.version,
    cards: reference.cards.length,
    symbols: reference.symbols.length,
  })
);

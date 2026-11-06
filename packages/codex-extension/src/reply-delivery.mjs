import { createHash } from "node:crypto";

const sha = (text) => createHash("sha256").update(text).digest("hex");
export const replyPartKey = (key, index) =>
  index === 0 ? key : `codex-${sha(`${key}:part:${index + 1}`)}`;

// Keep copyable codes, fenced content and links whole. Delivery boundaries are
// presentation only: never summarize, truncate or ask the model again here.
export function splitReply(text, softLimit = 240) {
  text = text
    .trim()
    .replace(/```(?:text)?\s*\n([A-Za-z0-9+/]{80,}={0,2})\s*\n```/g, "$1");
  const units = [];
  let at = 0;
  const prose = (value) => {
    for (const sentence of value.match(
      /[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/gu
    ) ?? []) {
      const chars = [...sentence];
      for (let i = 0; i < chars.length; i += softLimit)
        units.push(chars.slice(i, i + softLimit).join(""));
    }
  };
  for (const match of text.matchAll(
    /```[\s\S]*?```|https?:\/\/\S+|[A-Za-z0-9+/]{80,}={0,2}/g
  )) {
    prose(text.slice(at, match.index));
    units.push(match[0]);
    at = match.index + match[0].length;
  }
  prose(text.slice(at));
  const parts = [];
  let current = "";
  for (const unit of units) {
    if (current.trim() && current.length + unit.length > softLimit) {
      parts.push(current.trim());
      current = "";
    }
    current += unit;
  }
  if (current.trim()) parts.push(current.trim());
  while (parts.length > 3) {
    let index = 0;
    for (let i = 1; i < parts.length - 1; i++)
      if (
        parts[i].length + parts[i + 1].length <
        parts[index].length + parts[index + 1].length
      )
        index = i;
    parts.splice(index, 2, parts[index] + "\n" + parts[index + 1]);
  }
  return parts;
}

export function planReply(task) {
  return splitReply(task.reply).map((text, i) => ({
    key: replyPartKey(task.key, i),
    state: "prepared",
    text,
    textSha256: sha(text),
    characters: text.length,
  }));
}

export function clearReply(task) {
  delete task.reply;
  for (const part of task.replyParts ?? []) {
    delete part.text;
    if (!["done", "failed"].includes(part.state)) part.state = "cancelled";
  }
}

export function validateReplyParts(task) {
  if (task.replyParts === undefined) return;
  const parts = task.replyParts;
  if (!Array.isArray(parts) || !parts.length || parts.length > 3)
    throw Error("Invalid reply delivery plan");
  const terminal = ["done", "failed", "ignored", "dry-run"].includes(
    task.state
  );
  let unfinished = false,
    active = false;
  for (const [i, part] of parts.entries()) {
    if (
      !part ||
      part.key !== replyPartKey(task.key, i) ||
      ![
        "prepared",
        "submitting",
        "submitted",
        "unknown",
        "done",
        "failed",
        "cancelled",
      ].includes(part.state) ||
      !/^[a-f0-9]{64}$/.test(part.textSha256) ||
      !Number.isSafeInteger(part.characters) ||
      part.characters < 1 ||
      part.characters > 10000
    )
      throw Error("Invalid reply delivery part");
    if (part.state === "done") {
      if (unfinished) throw Error("Out-of-order reply delivery");
    } else unfinished = true;
    if (!terminal && !["done", "prepared"].includes(part.state)) {
      if (
        active ||
        parts.slice(0, i).some((p) => p.state !== "done") ||
        task.state !== part.state
      )
        throw Error("Invalid active reply delivery");
      active = true;
    }
    if (
      !terminal &&
      part.state !== "done" &&
      (typeof part.text !== "string" ||
        part.text.length !== part.characters ||
        sha(part.text) !== part.textSha256)
    )
      throw Error("Reply delivery text integrity mismatch");
    if (!terminal && part.state === "done" && part.text !== undefined)
      throw Error("Settled reply text must be removed");
  }
  if (!terminal && (!unfinished || (!active && task.state !== "prepared")))
    throw Error("Invalid reply delivery progress");
}

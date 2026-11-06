import test from "node:test";
import assert from "node:assert/strict";
import {
  splitReply,
  planReply,
  clearReply,
  validateReplyParts,
  replyPartKey,
} from "../src/reply-delivery.mjs";
import { encodeDeck } from "../src/decks.mjs";

const compact = (text) => text.replace(/\s/g, "");
test("short replies stay single; long prose is delivered in at most three ordered parts without dropping text", () => {
  assert.deepEqual(splitReply("换好啦。"), ["换好啦。"]);
  for (const text of [
    "甲".repeat(180) +
      "。\n\n" +
      "乙".repeat(180) +
      "。\n\n" +
      "丙".repeat(180) +
      "。",
    "先看这一点。".repeat(200),
  ]) {
    const parts = splitReply(text);
    assert.ok(parts.length >= 2 && parts.length <= 3);
    assert.equal(compact(parts.join("")), compact(text));
  }
});
test("deck codes, fenced text, URLs and Unicode characters stay intact across delivery boundaries", () => {
  const code = encodeDeck(Array.from({ length: 12 }, (_, i) => "Card" + i));
  const parts = splitReply("已替换：甲 → 乙\n\n```\n" + code + "\n```");
  assert.deepEqual(parts, ["已替换：甲 → 乙", code]);
  assert.equal(parts.filter((p) => p.includes(code)).length, 1);
  const fence =
      "```json\n" + JSON.stringify({ value: "字".repeat(600) }) + "\n```",
    url = "https://example.test/" + "a".repeat(300);
  for (const atomic of [fence, url])
    assert.ok(
      splitReply("说明。".repeat(90) + "\n" + atomic).some((p) =>
        p.includes(atomic)
      )
    );
  const emoji = "🦈".repeat(500),
    chunks = splitReply(emoji);
  assert.equal(compact(chunks.join("")), emoji);
  assert.ok(chunks.every((p) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(p)));
});
test("delivery keys and text hashes bind a saved plan; terminal cleanup keeps only receipt metadata", () => {
  const task = {
    key: "original-key",
    state: "prepared",
    reply: "甲".repeat(180) + "。\n\n" + "乙".repeat(180) + "。",
  };
  task.replyParts = planReply(task);
  validateReplyParts(task);
  assert.equal(task.replyParts[0].key, task.key);
  assert.equal(task.replyParts[1].key, replyPartKey(task.key, 1));
  for (const mutate of [
    (t) => (t.replyParts[1].key = t.key),
    (t) => (t.replyParts[1].text += "篡改"),
    (t) => (t.replyParts[1].state = "done"),
  ]) {
    const bad = structuredClone(task);
    mutate(bad);
    assert.throws(() => validateReplyParts(bad));
  }
  task.replyParts[0].state = "done";
  delete task.replyParts[0].text;
  task.replyParts[1].state = "unknown";
  task.state = "unknown";
  validateReplyParts(task);
  task.state = "ignored";
  clearReply(task);
  validateReplyParts(task);
  assert.ok(task.replyParts.every((p) => p.text === undefined));
  assert.equal(task.replyParts[1].state, "cancelled");
  validateReplyParts({ key: "legacy", state: "unknown" });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  selectReplyTarget,
  nativeQuoteReference,
  chooseReplyStyle,
} from "../src/reply-style.mjs";
const now = Date.parse("2026-11-06T00:00:00Z");
const message = (changes = {}) => ({
  id: "question",
  serverId: "123456789012345678",
  accountId: "account",
  threadId: "group",
  senderId: "one",
  direction: "incoming",
  type: 1,
  body: "具体问题",
  createdAt: new Date(now - 1000).toISOString(),
  ...changes,
});
const style = (target = message(), extra = {}) =>
  chooseReplyStyle({
    target,
    inputs: [target],
    recent: [target],
    now,
    ...extra,
  });

test("direct exchanges stay plain; image, quoted questions, delayed and explicitly disambiguated answers use native quotes", () => {
  assert.equal(style().mode, "plain");
  for (const m of [
    message({ type: 3 }),
    message({ type: 49, appMessageType: 57 }),
    message({ createdAt: new Date(now - 31000).toISOString() }),
  ])
    assert.equal(style(m).mode, "quote");
  assert.equal(
    style(message(), { quoteRequested: true }).reason,
    "topic-reference"
  );
  assert.equal(style(message(), { imageRequest: true }).reason, "image-answer");
  const target = message();
  assert.equal(
    style(target, { inputs: [target, message({ id: "later-topic" })] }).reason,
    "earlier-question"
  );
});
test("intervening real messages, including non-admitted senders, disambiguate without feeding their text to inference", () => {
  const target = message();
  for (const senderId of ["one", "outsider"])
    assert.equal(
      style(target, {
        recent: [
          target,
          message({
            id: "new",
            senderId,
            createdAt: new Date(now).toISOString(),
          }),
        ],
      }).reason,
      "intervening-message"
    );
  for (const change of [
    { threadId: "other" },
    { accountId: "other" },
    { recall: { state: "recalled" } },
    { direction: "outgoing" },
    { type: 10000 },
    { createdAt: "invalid" },
    { createdAt: new Date(now - 5000).toISOString() },
  ])
    assert.equal(
      style(target, { recent: [message({ id: "new", ...change })] }).mode,
      "plain"
    );
});
test("model can select only a supplied message; default selects a question rather than a trailing bare image", () => {
  const a = message(),
    b = message({ id: "second", senderId: "two" }),
    image = message({ id: "image", type: 3 });
  assert.equal(selectReplyTarget([a, b], 1), a);
  for (const invalid of [0, 3, 99, "1", -1])
    assert.equal(selectReplyTarget([a, b], invalid), b);
  assert.equal(selectReplyTarget([a, image]), a);
  assert.equal(selectReplyTarget([a, image], undefined, image), image);
  assert.equal(style(b, { inputs: [a, b] }).reason, "multiple-senders");
});
test("unsupported, recalled or non-canonical server identities never become quoted send references", () => {
  for (const change of [
    { serverId: null },
    { serverId: "0" },
    { serverId: "01" },
    { serverId: "18446744073709551616" },
    { serverId: 123 },
    { id: "" },
    { type: 10000 },
    { recall: { state: "recalled" } },
    { type: 49, appMessageType: 74 },
  ])
    assert.equal(nativeQuoteReference(message(change)), null);
  assert.deepEqual(nativeQuoteReference(message()), {
    messageId: "question",
    serverId: "123456789012345678",
  });
  assert.equal(
    style(message({ serverId: null }), { quoteRequested: true }).mode,
    "plain"
  );
});

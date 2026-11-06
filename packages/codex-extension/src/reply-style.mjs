import { describeMessage, isVisualMessage } from "./message-content.mjs";

export function selectReplyTarget(messages, index, preferred) {
  if (Number.isSafeInteger(index) && index >= 1 && index <= messages.length)
    return messages[index - 1];
  if (preferred) return messages.find((m) => m.id === preferred.id);
  return (
    [...messages]
      .reverse()
      .find((m) => ["text", "quote"].includes(describeMessage(m)?.kind)) ??
    messages.at(-1)
  );
}

export function nativeQuoteReference(message) {
  if (
    !message ||
    message.recall ||
    typeof message.id !== "string" ||
    !message.id ||
    typeof message.serverId !== "string" ||
    !/^[1-9]\d{0,19}$/.test(message.serverId) ||
    BigInt(message.serverId) > 18446744073709551615n
  )
    return null;
  if (
    ![1, 3, 47].includes(message.type) &&
    !(message.type === 49 && [8, 57].includes(message.appMessageType))
  )
    return null;
  return { messageId: message.id, serverId: message.serverId };
}

// Layout decisions use current canonical traffic; they do not admit extra
// senders to inference or copy their message bodies into model context.
export function chooseReplyStyle({
  target,
  inputs,
  recent,
  now,
  quoteRequested = false,
  imageRequest = false,
}) {
  const quote = nativeQuoteReference(target);
  if (!quote) return { mode: "plain", reason: "reference-unavailable" };
  const lastQuestion = [...inputs]
    .reverse()
    .find((m) => ["text", "quote"].includes(describeMessage(m)?.kind));
  let reason;
  if (isVisualMessage(target) || imageRequest) reason = "image-answer";
  else if (describeMessage(target)?.kind === "quote")
    reason = "quoted-question";
  else if (new Set(inputs.map((m) => m.senderId)).size > 1)
    reason = "multiple-senders";
  else if (lastQuestion && lastQuestion.id !== target.id)
    reason = "earlier-question";
  else if (quoteRequested) reason = "topic-reference";
  else {
    const ids = new Set(inputs.map((m) => m.id));
    const at = Date.parse(target.createdAt);
    if (
      recent.some(
        (m) =>
          m.accountId === target.accountId &&
          m.threadId === target.threadId &&
          !ids.has(m.id) &&
          m.direction === "incoming" &&
          !m.recall &&
          m.type !== 10000 &&
          m.senderId &&
          Number.isFinite(Date.parse(m.createdAt)) &&
          Date.parse(m.createdAt) >= at &&
          Date.parse(m.createdAt) <= now + 60000
      )
    )
      reason = "intervening-message";
    else if (Number.isFinite(at) && now - at >= 30000)
      reason = "delayed-answer";
  }
  return reason
    ? { mode: "quote", reason, quote }
    : { mode: "plain", reason: "direct-conversation" };
}

import { describeMessage } from './message-content.mjs';

export function receivedQuote(message) {
  const quote = message.quote;
  if (message.type !== 49 || message.appMessageType !== 57 || !quote || quote.state !== 'embedded'
    || typeof quote.senderId !== 'string' || !quote.senderId
    || typeof quote.serverId !== 'string' || !/^[1-9]\d{0,19}$/.test(quote.serverId)
    || BigInt(quote.serverId) > 18446744073709551615n) return null;
  return quote;
}

export function quotesAssistant(message, ownUsername) {
  const quote = receivedQuote(message);
  return !!quote && quote.senderId === ownUsername && quote.direction === 'outgoing';
}

export function quotedInput(message) {
  const quote = receivedQuote(message);
  return quote ? { sender: quote.senderId, text: typeof quote.embeddedText === 'string' ? quote.embeddedText.slice(0, 2000) : '', type: quote.type } : null;
}

export function inputChars(message) {
  return (describeMessage(message)?.text.length ?? 0) + (quotedInput(message)?.text.length ?? 0);
}

// Verify identity against the canonical same-chat store, but never substitute a
// stored original's text for the excerpt delivered inside the quote.
export async function verifyAssistantQuote(client, config, message, signal) {
  const quote = receivedQuote(message); if (!quote) return false;
  let cursor;
  for (let page = 0; page < 100; page++) {
    signal?.throwIfAborted();
    const result = await client.messages(config.accountId, message.threadId, { limit: 200, ...(cursor ? { cursor } : {}) }, signal);
    signal?.throwIfAborted();
    const original = result.items.find(item => item.serverId === quote.serverId);
    if (original) return original.accountId === config.accountId && original.threadId === message.threadId
      && original.direction === 'outgoing' && original.senderId === config.ownUsername && !original.recall;
    if (!result.nextCursor || result.nextCursor === cursor) return false;
    cursor = result.nextCursor;
  }
  return false;
}

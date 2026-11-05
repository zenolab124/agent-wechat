const videoTypes = new Set([43, 62]);
const videoApps = new Set([4, 51]);

export function isVideoMessage(message) {
  const q = message.quote;
  return videoTypes.has(message.type) || message.type === 49 && videoApps.has(message.appMessageType)
    || !!q && (videoTypes.has(q.type) || q.type === 49 && videoApps.has(q.appMessageType))
    || Array.isArray(message.media) && message.media.some(item => item?.kind === 'video');
}

export function describeMessage(message) {
  if (isVideoMessage(message)) return null;
  if (message.type === 1) return typeof message.body === 'string' && message.body.trim()
    ? { kind: 'text', text: message.body.slice(0, 4000) } : null;
  if (message.type === 49 && message.appMessageType === 57) return {
    kind: 'quote', text: typeof message.body === 'string' ? message.body.slice(0, 4000) : '',
  };
  if (message.type === 3) return { kind: 'image', text: '[图片]', contentStatus: 'not-prepared' };
  if (message.type === 47 || message.type === 49 && message.appMessageType === 8)
    return { kind: 'sticker', text: '[表情包]', contentStatus: 'not-prepared' };
  return null;
}

export function isVisualMessage(message) {
  const content = describeMessage(message);
  return content?.kind === 'image' || content?.kind === 'sticker' || content?.kind === 'quote'
    && message.quote?.state === 'embedded' && (message.quote.embeddedImage === true || message.quote.embeddedSticker === true);
}

export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens'];

export function tokenUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const field of TOKEN_FIELDS) {
    const n = field === 'cacheWriteInputTokens' ? value[field] ?? 0 : value[field];
    if (!Number.isSafeInteger(n) || n < 0) return null;
    result[field] = n;
  }
  if (result.cachedInputTokens > result.inputTokens || result.reasoningOutputTokens > result.outputTokens) return null;
  return result;
}

export function groupUsage(data, threadId) {
  return data.usage.groups[threadId] ??= {
    observedMessages: 0, mergedMessages: 0, callsStarted: 0, completedCalls: 0, failedCalls: 0,
    unknownCalls: 0, silentCalls: 0, reportedCalls: 0, unreportedCalls: 0,
    rateLimitedBatches: 0, rateLimitedMessages: 0, repliesAccepted: 0,
    lastCallAt: null, callTimes: [], tokens: Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])),
  };
}

export function recordResult(data, task, rawUsage, outcome) {
  if (task.resultRecorded) return;
  const group = groupUsage(data, task.threadId);
  group[outcome === 'completed' ? 'completedCalls' : outcome === 'failed' ? 'failedCalls' : 'unknownCalls']++;
  const usage = tokenUsage(rawUsage);
  group[usage ? 'reportedCalls' : 'unreportedCalls']++;
  if (usage) for (const key of TOKEN_FIELDS) group.tokens[key] += usage[key];
  task.resultRecorded = true;
  task.usageReported = usage !== null;
}

export function usageSnapshot(data, now = Date.now()) {
  return {
    since: data.usage.since,
    groups: Object.entries(data.usage.groups).map(([threadId, value]) => {
      const { tokens, callTimes, ...counters } = value;
      const unresolvedCalls = value.callsStarted - value.completedCalls - value.failedCalls - value.unknownCalls;
      return { threadId, ...counters, reportedTokens: tokens,
        callsInLastHour: callTimes.filter(at => at > now - 3600000).length, unresolvedCalls,
        unknownUsageCalls: value.unreportedCalls + unresolvedCalls,
        tokenUsageComplete: value.unreportedCalls === 0 && unresolvedCalls === 0 };
    }),
    tokenSemantics: 'Reported totals only. Cached input is included in inputTokens; reasoning is included in outputTokens. Missing usage is unknown, not zero. No currency estimate.',
  };
}

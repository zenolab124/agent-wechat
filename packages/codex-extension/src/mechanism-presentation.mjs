// These are formatting checks, not a mechanism answer. A detected diagnostic
// dump goes back to the same model turn stream for a supported player summary.
export function needsPlayerRewrite(text, { allowTestingSummary = false } = {}) {
  if (typeof text !== "string") return false;
  if (
    !allowTestingSummary &&
    /我(?:刚|已经)?(?:做|跑|测)了|测试(?:假设|版本)[：:]|报告(?:没有|未列)|(?:不是|不代表)客户端实测/.test(
      text
    )
  )
    return true;
  return (
    typeof text === "string" &&
    /```|\bBehavior::|\b(?:galacti_picks|simulation_trace|traceAvailable|openingInitialized|TargetEntityId|StartOfGameTrigger|OnReveal|sourceTreeSha256)\b|\b(?:pub\s+)?fn\s+\w+\s*\(|\bengine_(?:explain|compare|opening_test|test|read)\b|\bcn-\d+(?:\.\d+)*-dv\d+\b|固定种子\s*\d+|(?:第?[①②③]|[①②③])档/.test(
      text
    )
  );
}

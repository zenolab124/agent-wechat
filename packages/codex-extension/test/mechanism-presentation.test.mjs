import test from "node:test";
import assert from "node:assert/strict";
import { needsPlayerRewrite } from "../src/mechanism-presentation.mjs";
test("player summaries preserve game concepts but diagnostic code, metadata and unsolicited test reports are rewritten", () => {
  assert.equal(
    needsPlayerRewrite(
      "按当前验证，这里借用了揭示效果，但没有继承开局选好的目标，所以没有牌可变。"
    ),
    false
  );
  for (const text of [
    "fn stryfe() {}",
    "galacti_picks = []",
    "cn-48.18-dv0 ②档",
    "我做了两组对照，逐步解释报告。",
    "这不是客户端实测",
  ])
    assert.equal(needsPlayerRewrite(text), true, text);
  assert.equal(
    needsPlayerRewrite("我做了两组对照，只改变出牌顺序。", {
      allowTestingSummary: true,
    }),
    false
  );
  assert.equal(
    needsPlayerRewrite("galacti_picks", { allowTestingSummary: true }),
    true
  );
});

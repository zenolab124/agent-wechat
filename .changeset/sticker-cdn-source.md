---
"@agent-wechat/cli": patch
"@agent-wechat/codex-extension": patch
---

Accept incoming sticker bytes from the exact Tencent CDN host
`vweixinf.tc.qq.com` while retaining URL, public-address pinning, byte-size and
integrity checks. Distinguish unsupported sticker sources in Codex media status.

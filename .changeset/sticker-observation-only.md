---
"@agent-wechat/codex-extension": patch
---

Keep standalone sticker batches in model context without sending a reply, so a
following text question does not receive a second unsolicited explanation. Preserve
required replies to verified assistant quotes and ordinary mixed-message batching.

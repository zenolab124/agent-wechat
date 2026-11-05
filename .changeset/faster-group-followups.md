---
"@agent-wechat/codex-extension": patch
---

Allow disabling call and reply cooldowns without disabling hourly caps, make event polling configurable, and expose separately measured wait/model/send latency in the local debugger. Preserve existing defaults for other configurations.

Ship the debugger browser entry as an mjs source module so it is included despite the repository's generated-JavaScript ignore rule.

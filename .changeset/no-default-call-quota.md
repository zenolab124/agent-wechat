---
"@agent-wechat/codex-extension": patch
---

Disable hourly model-call quotas, call intervals and reply cooldowns by default.
Support maxCallsPerHour=0 as unlimited and display that state in the debugger,
while preserving existing usage and send receipts.

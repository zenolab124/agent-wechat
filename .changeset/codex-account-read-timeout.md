---
"@agent-wechat/codex-extension": patch
---

Bound retries of internal read-only account preflight timeouts and identify the failing RPC method without logging private error text. Authentication rejections and send submissions are not retried.

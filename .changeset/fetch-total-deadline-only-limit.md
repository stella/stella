---
"@stll/fetch": patch
---

A total deadline is now the only limit on a request: `fetchWithTimeout` turns off Bun's idle limit, which cut a response that stayed silent for about five minutes whatever the deadline allowed. A `headers` policy keeps it.

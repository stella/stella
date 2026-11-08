---
"@stll/fetch": minor
---

A total deadline is now the only limit on a request: `fetchWithTimeout` turns off Bun's idle limit, which cut a response that stayed silent for about five minutes whatever the deadline allowed. A `headers` policy keeps it.

Breaking for a custom `Fetcher`: `TransportRequestInit.timeout` can now be `false`, and a total deadline passes `false` where it passed the policy. Read the deadline from `signal` or `timeoutMs`.

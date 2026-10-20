---
"@stll/cli": patch
---

`stella upload` retries a finalization the server refused as busy, waiting the advised delay, up to five attempts, and prints each wait.

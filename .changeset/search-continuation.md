---
"@stll/cli": patch
---

`search_case_law` and `search_legislation` can answer `status: "running"` with `continuation_token` when a search outlives its response deadline, instead of timing out. Calling again with the token collects the answer. Two new error codes: `continuation_expired` and `public_read_unfinished`.

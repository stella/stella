---
"@stll/cli": patch
---

`search_case_law` returns the phrasings that finished when another phrasing runs out of its time budget; that phrasing reports a `time_budget` truncated outcome and a `phrasing_timed_out` warning instead of failing the call.

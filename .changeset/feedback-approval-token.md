---
"@stll/cli": patch
---

`stella feedback submit` takes the `approval_token` that `stella feedback prepare` returns; the server refuses a report the token does not cover. Key-value output no longer truncates values without whitespace (tokens, ids, URLs), so they can be copied at any terminal width.

---
"@stll/cli": minor
---

`case-law search` no longer requires a question's function words. It reports
`searches[].queryUsed` (the words the search required) and
`searches[].warnings`, and takes `--strict` to require every word.

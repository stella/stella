---
"@stll/cli": patch
---

`lists.source-documents.update` marks a document as testimony (a witness statement, interview note or transcript) or a record for one list's facts, and `lists.source-documents.list` reads the kind of each named document. `lists.items.list` returns each fact's tier (`document`, `testimony` or `unsourced`); `lists.verifications.get` returns the tier of each pinned fact in place of `sourcing`, the `testimony-only` qualifier, and for a record conflict the fact suggested to govern it.

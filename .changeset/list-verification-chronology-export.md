---
"@stll/cli": patch
---

Add `lists.verifications.chronology.export`: downloads the chronology of one list as a DOCX or CSV table, a row per fact in the order it happened with its first source and the claims citing it with their verdict. `lists.verifications.graph.get` now gives each claim's printed paragraph number (`paragraph`) and each source link's `quote`.

---
"@stll/anonymize": patch
---

Drop two EDGAR employment-agreement false positives: person spans ending in
configured defined-term heads such as `Job Description`, and city-list address
hits ending in a language-scoped non-address head such as `Independence Day`.

---
"@stll/anonymize-chat": patch
---

Export the exclusion comparison key so document exports use the same normalization as the anonymization pipeline.

Update the anonymization runtime to 3.0.1 to preserve source byte offsets when resolving entities with normalized whitespace.

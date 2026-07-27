---
"@stll/anonymize": patch
"@stll/anonymize-cli": patch
---

Require `@stll/anonymize-data` 0.0.9, which moves the city API to a `./cities`
subpath. The city loader map holds one literal `import()` per covered country,
so bundling anything from the data package root emitted all 237 city chunks
(~815 KiB) even for a consumer that only loaded name dictionaries.

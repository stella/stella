---
"@stll/anonymize": patch
"@stll/anonymize-cli": patch
---

Require `@stll/anonymize-data` 0.0.8, whose city dictionaries load through
literal `import()` specifiers. The previous computed specifier was invisible
to bundlers, so bundled consumers silently received empty city lists and
under-redacted places.

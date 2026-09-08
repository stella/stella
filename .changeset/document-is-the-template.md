---
"@stll/template-conditions": minor
---

The marker grammar gains a writer: `renderValueMarker`, `renderForOpener` and `renderFilterChain` produce the text the scanner reads, and `isWritableMarkerText` / `isWritableMarkerLiteral` / `unwritableFilterValues` name the values it has no spelling for (braces, exponent notation). A quoted argument's `\`-escapes are now recognized by the span pattern as well as by the argument scanner, so `label("she said \"yes\"")` is one marker instead of three.

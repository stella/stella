---
"@stll/template-conditions": minor
---

The package gains the writer half of the template language. `filtersFromFieldConfig` / `arrayFiltersFromFieldConfig` turn a field's configuration into the filter chain that declares it, over a structural `MarkerFieldConfig` both the api and the editor satisfy, so one mapping serves every surface that configures a field. `renderValueMarker`, `renderForOpener`, `renderConditionTag` and `renderFilterChain` produce the marker text the scanner reads, and `isWritableMarkerText` / `isWritableMarkerLiteral` / `unwritableFilterValues` name the values the grammar has no spelling for (braces, exponent notation).

Composite field values are gone: `renderComposite` and `PartConfig` are removed, and `DeterministicFieldConfig` no longer carries `parts` or `format`.

A quoted argument's `\`-escapes are now recognized by the span pattern as well as by the argument scanner, so `label("she said \"yes\"")` is one marker instead of three.

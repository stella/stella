# @stll/collation

Locale-aware string collation with a cached Intl.Collator per locale, plus the codepoint comparator for technical keys.

## What lives here

Locale-aware string collation with a cached Intl.Collator per locale, plus a locale-independent comparator for technical keys (UTF-16 code-unit order, the same order as JavaScript `<`), and the tests that pin its behaviour.

## What does not

Anything outside that concern: app-specific wiring, one-off helpers, and
code another package already owns.

## License

Apache-2.0

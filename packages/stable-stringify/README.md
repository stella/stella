# @stll/stable-stringify

Deterministic string form of JSON-shaped values, for fingerprints and cache keys that must agree across environments.

## What lives here

Deterministic string form of JSON-shaped values, for fingerprints and cache keys that must agree across environments, and the tests that pin its behaviour. Keys sort in UTF-16 code-unit order, the order of JavaScript `<`.

The input contract is the exported `StableStringifyInput` type: primitives, arrays, and string-keyed plain objects, plus `undefined`, `bigint`, `symbol`, and functions, each of which gets a spelling rather than being dropped. A live `Date`, `Map`, or `Set` is a compile error at the call site, because it would serialize through its enumerable own keys and read as `{}`. Fingerprint data after it crosses a JSON boundary, not live instances.

## What does not

Anything outside that concern: app-specific wiring, one-off helpers, and
code another package already owns.

## License

Apache-2.0

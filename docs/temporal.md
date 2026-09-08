# Temporal conventions

Temporal owns clock and calendar logic in TypeScript. Private workspace packages
and runnable apps import `Temporal` from `@stll/time`. Packages published to npm
import it directly from `temporal-polyfill/full` and declare that runtime
dependency themselves. Both entrypoints use the runtime's native implementation
when available and the ponyfill otherwise. Application code must not install or read an ambient
`globalThis.Temporal`; explicit imports also reach server rendering, web workers,
desktop webviews, and mobile runtimes without entrypoint ordering assumptions.
The web Vite build selects native Temporal before dynamically loading the fallback,
so browsers with native support do not download the implementation. This preserves
the same explicit imports and does not install an ambient global.

Use the type that matches the value:

- `Temporal.PlainDate` for a calendar day without time or timezone.
- `Temporal.Instant` for an exact point on the UTC timeline.
- `Temporal.ZonedDateTime` when calendar operations require an IANA timezone.
- `Temporal.Duration` for an amount of time.

Keep API, database, cache, and worker payloads as their existing string or numeric
contracts. Serialize `PlainDate` with `.toString()`. Serialize an `Instant` for an
existing ISO timestamp contract inline with
`.toString({ fractionalSecondDigits: 3 })`; this preserves the millisecond field
that `Date.prototype.toISOString()` always emitted. A `ZonedDateTime` string
includes its bracketed timezone, so serialize one only when the contract owns that
timezone. JSON serialization produces strings but JSON parsing cannot infer which
Temporal type to restore; parse at the owning schema boundary. The
[Temporal string documentation](https://tc39.es/proposal-temporal/docs/strings.html)
describes these wire forms.

Legacy `Date` remains valid only where a concrete library contract requires it:
Drizzle timestamp values, vendor SDK parameters and results, UI libraries with
`Date` props, and protocol fields such as HTTP dates. Construct that boundary
value directly from `instant.epochMilliseconds`; convert incoming Dates directly
with `Temporal.Instant.fromEpochMilliseconds(date.getTime())`. Keep the conversion
at the call site so a generic adapter cannot make Date convenient in domain logic.
Temporal intentionally parses standardized Temporal strings rather than every
legacy protocol date. A required HTTP-date header parser uses
`new Date(header).getTime()` at that protocol boundary, with a comment naming the
grammar that Temporal cannot parse.

The `prefer-temporal` Oxlint rule enforces the syntax it can prove safely. It bans
the `Date` call form, `Date.now`, `Date.parse`, `Date.UTC`, multi-argument calendar
construction, immediate non-boundary methods on a constructed Date, and calendar
getters or setters on typed or locally inferred Dates. Single-argument and
unchained zero-argument construction remain available for library boundaries;
`getTime`, `toISOString`, `toJSON`, and `toUTCString` remain available on an
immediately constructed single-argument Date for ingress and serialization.
Zero-argument clock reads such as `new Date().getTime()` and
`new Date().toISOString()` are banned; `new Date().toUTCString()` remains valid
for a current HTTP-date header. The rule deliberately
does not guess the type of opaque object properties or function results, which
avoids matching unrelated APIs that also have names such as `setDate`.
These allowed constructor shapes are syntax limits, not proof that a call site is
a valid boundary: reviewers must still reject a single string argument that carries
a calendar date or a zero-argument Date used for domain clock logic. The existing
date-parsing rule catches literal date-only strings, but a variable string remains
opaque to syntax-only lint.

`Temporal.Now` is ambient time. Deterministic policy and normalization modules use
a caller-owned clock, and the `no-ambient-nondeterminism` rule rejects both
`Date.now()` and `Temporal.Now.*()` in those modules.

The ponyfill entrypoint and runtime selection behavior are documented by the
[`temporal-polyfill` package](https://github.com/fullcalendar/temporal-polyfill/blob/main/polyfill/README.md).

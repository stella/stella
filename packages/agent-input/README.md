# @stll/agent-input

Lenient readers for values agents write: dates, date-format specs, numbers, booleans, locales, countries, enum values.

## What lives here

One reader per value kind that reaches a tool input, a template marker, or a
fill value. Each reads the spellings that carry a single meaning (`4 000`,
`1. 10. 2026`, `ano`, `cs_CZ`, `Česko`) and returns the one ask-for-a-fix shape
when a spelling carries two (`01/02/2026`, a bare `1,234`, a bare `cs`), so no
call site grows its own parser or its own wording.

`normalizeCountry` reads ISO 3166-1 alpha-3 and alpha-2 codes and the country's
name in each language the corpus serves, and returns both canonical spellings so
a caller keeps the one its column holds. The names come from CLDR through
`Intl.DisplayNames` rather than from a table maintained here; only the official
long forms CLDR omits (`Česká republika` against its `Česko`) are declared.
Recognising a country is not admitting it: whether a corpus holds that
jurisdiction stays the caller's `not_found`.

`normalizeAgentInput` derives a recursive normalization plan from the canonical
JSON Schema. Standard number, boolean, string-enum, and `format: date` keywords
are the annotations for those kinds; `x-stella-agent-input` names locale and
date-format fields that JSON Schema cannot distinguish from ordinary strings or
objects. `agentInputNormalizationMetadata` emits that annotation and its MCP/CLI
guidance together. `invalidValueDisposition: "handler-owned"` is reserved for
handlers that deliberately repair invalid properties while applying valid
siblings; valid spellings still normalize through the shared reader.

## What does not

Transport, strict schema validation, and persistence. First-party agent
transports call the shared API dispatch boundary; upstream MCP servers keep
their own contracts. Ordinary strings are never normalized heuristically.

## License

Apache-2.0

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

A third outcome exists only on optional inputs: `ok: "absent"`, the input read
as no value (`readAsAbsent`, `NormalizedOptional<T>`). A model fills every slot
it is shown, so a filter it is not setting still arrives as `"any"`, `"-"`, the
nil uuid, or `9999-12-31`. `isAbsentPlaceholder` holds the closed set of
placeholder words; it is never applied to free text, and the caller decides
which inputs it covers.

`normalizeUuid` reads an id in any spelling that names the same 128 bits
(uppercase, `{...}`, `urn:uuid:`, no dashes) as the lowercase dashed form, and
reads the ids a model invents when it has none (nil, max, one repeated digit,
the RFC and tutorial examples) as no value.

`normalizeVocabularyValue` reads a filter value whose allowed set comes from
data rather than the schema: court names, decision types. It widens step by
step, from the exact value through folded spellings and aliases to word
containment, and stops at the first step that finds exactly one entry, so
`Ústavní soud České republiky` reads as `Ústavní soud` while `Krajský soud`
asks which regional court. Closed schema enums stay with `normalizeEnumValue`.

`normalizeStringList` reads an array sent as its JSON string, and a bare string
as a list. Whether a bare string is split on commas is the caller's `split`:
ids can be, free-text phrases cannot.

`normalizeDateBound` reads one end of a date range: a bare year or month is that
end's first or last day, an open-ended sentinel year (`0001`, `9999`) is no
bound, and a whole range written into one field asks for its two halves.
`normalizeDateValue` takes the same `bound` without the absent outcome.

`normalizeNumberInRange` clamps a bounded count (a page size) into range with a
note instead of asking, and asks about a fraction where the count is whole.
Which fields clamp is the caller's choice.

`normalizeEli` reads a European Legislation Identifier with or without its
origin, in any case, with a trailing slash, or with year and number swapped, as
the canonical work identifier under the publisher origin the caller maps each
jurisdiction to. A path past the work (a version date, a provision) asks for
the work; an input that is not an ELI goes through the caller's citation reader
before it asks.

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

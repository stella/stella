# @stll/agent-input

Lenient readers for values agents write: dates, date-format specs, numbers, booleans, locales, enum values.

## What lives here

One reader per value kind that reaches a tool input, a template marker, or a
fill value. Each reads the spellings that carry a single meaning (`4 000`,
`1. 10. 2026`, `ano`, `cs_CZ`) and returns the one ask-for-a-fix shape when a
spelling carries two (`01/02/2026`, a bare `1,234`), so no call site grows its
own parser or its own wording.

`normalizeAgentInput` derives a recursive normalization plan from the canonical
JSON Schema. Standard number, boolean, string-enum, and `format: date` keywords
are the annotations for those kinds; `x-stella-agent-input` names locale and
date-format fields that JSON Schema cannot distinguish from ordinary strings or
objects. `agentInputNormalizationMetadata` emits that annotation and its MCP/CLI
guidance together.

## What does not

Transport, strict schema validation, and persistence. First-party agent
transports call the shared API dispatch boundary; upstream MCP servers keep
their own contracts. Ordinary strings are never normalized heuristically.

## License

Apache-2.0

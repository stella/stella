# @stll/agent-input

Lenient readers for values agents write: dates, date-format specs, numbers, booleans, locales, enum values.

## What lives here

One reader per value kind that reaches a tool input, a template marker, or a
fill value. Each reads the spellings that carry a single meaning (`4 000`,
`1. 10. 2026`, `ano`, `cs_CZ`) and returns the one ask-for-a-fix shape when a
spelling carries two (`01/02/2026`, a bare `1,234`), so no call site grows its
own parser or its own wording.

## What does not

Schema validation, transport, and persistence. A reader answers what one
spelling means; the surface that called it decides what to do with the answer.

## License

Apache-2.0

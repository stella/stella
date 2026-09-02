---
"@stll/cli": patch
---

The generated agent skill (`stella-cli/SKILL.md`) now documents every curated
command's flags (name, required/optional, type, one-line description) and adds
a "When no curated command fits" section: the live capability domain list, two
worked `stella capability <domain> <action>` examples, and a note that
`--input` JSON keys follow the schema's own casing (snake_case for curated
tools, camelCase for capability commands) rather than a guessable convention.
It also states that the CLI cannot upload a binary file (a new document
version), which needs an MCP-connected client or the web app instead.

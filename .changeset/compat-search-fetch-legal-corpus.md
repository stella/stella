---
"@stll/cli": patch
---

Regenerate the MCP registry snapshot: the OpenAI-compatible `search` and `fetch` now state their result-id vocabulary, and `fetch` accepts a prefixed corpus id beside a document UUID. Both stay excluded from the CLI, which has its own corpus commands.

---
"@stll/chat": patch
---

`htmlToMarkdown` loads HTML through `@stll/html` instead of Cheerio's main entry, so the chat package no longer bundles Cheerio's byte decoders or HTTP client.

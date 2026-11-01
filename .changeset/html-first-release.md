---
"@stll/html": minor
---

First release: `load` parses HTML strings with parse5 and returns a Cheerio document without Cheerio's byte decoders or HTTP client; the root entry also carries the Cheerio types and `@stll/html/nodes` the DOM types and predicates, `@stll/html/bounded` limits allocations while loading, and `@stll/html/email` owns the scripting-disabled mode for email previews.

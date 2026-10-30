# @stll/html

String HTML and XML loading for tree-based consumers. HTML uses parse5 with
its htmlparser2 tree adapter; XML uses `cheerio/slim` directly. This keeps
Cheerio's byte decoders and HTTP client out of the server bundle.

Import `load` from `@stll/html`; import Cheerio types from `@stll/html/selection` and DOM node types and predicates from `@stll/html/nodes`.
Document mode is the default. Pass `false` as the third argument for fragments.
The loader preserves parse5 serialization and context-aware parsing of inserted
HTML through the per-document Cheerio hooks. XML options retain slim's parser
and serializer.

Fixture equivalence goldens live beside the API's HTML fixtures test in
`apps/api/src/lib/html/loader-equivalence.test.ts`. They contain SHA-256 hashes
of the original Cheerio 1.2.0 HTML, XML, text, and post-insertion HTML output,
plus input hashes, across every enrolled input and parser mode.

Apache-2.0.

`@stll/html/email` owns the shared scripting-disabled parse and serialization mode
for email previews. `@stll/html/bounded` limits allocations during initial HTML
loading, leaving later document edits outside that budget. `htmlTreeAdapter` is
available for adapter instrumentation. Parser dependencies are declared only here.

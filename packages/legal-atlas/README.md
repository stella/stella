<p align="center">
  <img src=".github/assets/banner.png" alt="stll/legal-atlas" width="100%" />
</p>

# @stll/legal-atlas

Legal Atlas is a home for collecting and parsing public legal data worldwide.

Court websites, gazettes, legislation portals, PDF archives, XML dumps, and
government APIs all publish law in different shapes. Legal Atlas brings those
sources into one contributor-friendly place: adapters fetch the official
material, parsers preserve its structure, and normalizers turn it into stable
records that downstream tools can search, cite, render, and analyze.

## What Belongs Here

- Source adapters for courts, legislation portals, gazettes, and registries.
- Parsers that preserve structure instead of flattening everything to text.
- Normalizers that map local labels into shared legal ASTs.
- Citation extractors and source-quality checks.
- Corpus runners for ingestion and search-index projection.

If it collects, parses, or normalizes public legal material, it should probably
live here.

## Why Contribute?

Legal data is public in theory and fragmented in practice. Many countries expose
rich official sources, but the formats are hard to reuse: brittle HTML, scanned
PDFs, national abbreviations, inconsistent identifiers, local citation styles,
and portals that change without warning.

Legal Atlas turns that long tail into reviewable contributions: add a parser,
preserve better metadata, improve citation extraction, or bring in a new
jurisdiction.

Good contributions are small and source-driven:

- one court, gazette, registry, or legislation portal;
- real fixtures from the public source;
- a parser that keeps headings, paragraphs, tables, anchors, and citations;
- tests that prove the source can change without silently losing content.

The ambition is broad: make official legal sources easier to reuse without
erasing the structure that makes them legally meaningful.

## Runner Image

Legal Atlas runtime jobs live in `@stll/legal-atlas-runner`, a small Bun app
that wraps this package for Docker and scheduled tasks.

```sh
docker build -f apps/legal-atlas-runner/Dockerfile -t stella-legal-atlas .
docker run --rm stella-legal-atlas list
```

Runner slots:

```text
case-law-ingest  implemented
statute-ingest   reserved
search-index     reserved
```

Each runner can become its own service, scheduled task, or local job while
sharing this package boundary.

## Local Commands

```sh
bun --filter @stll/legal-atlas test
bun --filter @stll/legal-atlas-runner smoke
bun --filter @stll/legal-atlas-runner start -- list
bun --filter @stll/legal-atlas-runner start -- run case-law-ingest
```

The case-law ingestion daemon is wired through `@stll/legal-atlas-runner`.
Some persistence and search dependencies still live behind API modules while
the corpus internals are extracted into this package.

## Package Boundaries

- Persisted legal document shapes live in `@stll/legal-ast`.
- Public source adapters and parsers live here.
- API route handlers and UI code do not live here.
- Search engine details stay behind provider-neutral indexing code.

## License

Apache-2.0

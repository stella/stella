<p align="center">
  <img src="https://raw.githubusercontent.com/stella/stella/main/.github/assets/banners/legal-atlas.webp" alt="stll/legal-atlas" width="100%" />
</p>

# @stll/legal-atlas

Shared definitions for Stella's public legal corpus:

- `./runners/registry`: the corpus runner registry (names, status, and
  descriptions of the jobs `@stll/legal-atlas-runner` can run).
- `./corpus`: corpus document kinds, projection kinds, and the `CorpusAst`
  union over `@stll/legal-ast`.
- `./provision-citation-grammars`: per-jurisdiction grammars for statute
  provision citations.
- `./provision-citation-profile`, `./cz-provision-citation-profile`,
  `./sk-provision-citation-profile`: jurisdiction profiles (citation
  vocabulary, act aliases and titles with their cited-date windows, anchor
  schemes).

Source adapters and parsers are not here: the case-law adapters live in
`apps/api/src/handlers/case-law/ingestion/adapters`.

## Runner Image

Legal Atlas runtime jobs live in `@stll/legal-atlas-runner`, a small Bun app
that wraps this package for Docker and scheduled tasks.

```sh
docker build -f apps/legal-atlas-runner/Dockerfile -t stella-legal-atlas .
docker run --rm stella-legal-atlas list
```

Runner slots:

```text
case-law-ingest                   implemented
case-law-corpus-storage-backfill  implemented
legal-corpus-storage-backfill     implemented
statute-ingest                    reserved
search-index                      reserved
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

The case-law ingestion daemon is wired through `@stll/legal-atlas-runner`;
its adapters, persistence, and search dependencies live behind API modules.

## Package Boundaries

- Persisted legal document shapes live in `@stll/legal-ast`.
- API route handlers and UI code do not live here.
- Search engine details stay behind provider-neutral indexing code.

## Statute Citation Grammars

`PROVISION_CITATION_GRAMMARS` is total over the case-law jurisdictions: each
entry declares how that jurisdiction prints a provision, which abbreviations
its courts use for its own acts, which gazette names a work, and which anchor
a parsed reference lands on in the statute AST. A jurisdiction without a
grammar is an explicit `unsupported` entry; its decisions read citations as
text rather than through another country's typography.

To onboard a jurisdiction, replace its entry with
`createProvisionCitationGrammar({ … })` and add its fixture sentence to the
grammar test. A grammar only belongs to a jurisdiction whose acts the
legislation corpus can open.

## License

Apache-2.0

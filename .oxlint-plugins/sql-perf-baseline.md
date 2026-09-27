# SQL performance baseline

The JSON file records existing unsuppressed findings by source path. Lower a
file's count when its query is changed; `bun scripts/sql-perf-baseline.ts --write`
cannot raise counts.

Pending query fixes are in:

- `apps/api/src/lib/legal-search/case-law-raw-sweeps.ts`
- `apps/api/src/handlers/case-law/decisions/sitemap.ts`
- `apps/api/src/lib/legal-search/pg-fts-browse-facets.ts`
- `apps/api/src/lib/search/index-global.ts`

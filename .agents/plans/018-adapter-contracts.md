# 018: Adapter Contracts & Shared Utilities

Status: **done**

## Summary

Two workstreams to reduce duplication and improve error
handling across case-law ingestion adapters and file
processing subprocesses.

## Workstream A: Case-law adapter error contracts

### Problem
All 6 adapters threw raw `Error` on fetch failures, making
it impossible for the pipeline to distinguish adapter errors
from other exceptions. Utility functions (`hashResult`,
`stripHtml`, date parsers) were duplicated across adapters.

### Changes
1. Added `AdapterFetchError` to `lib/errors/tagged-errors.ts`
   with structured fields: `adapterKey`, `cursor`,
   `httpStatus`, `cause`.

2. Created shared `adapters/utils.ts`:
   - `hashContent`: SHA-256 via `Bun.CryptoHasher`
   - `stripHtml`: tag removal, entity decoding, newline
     collapsing
   - `parseCeDate`: unified CZ/SK date parser ("D. M. YYYY"
     and "DD.MM.YYYY" to ISO)

3. Changed `SourceAdapter.fetchPage` return type from
   `Promise<SyncPage>` to
   `Promise<Result<SyncPage, AdapterFetchError>>`.

4. Updated all 6 adapters:
   - Replaced local `hashResult` with `hashContent`
   - Replaced local `stripHtml`/date parsers with shared
     versions (cz-supreme, cz-constitutional, sk-courts)
   - Wrapped fetch logic in `Result.tryPromise`
   - cz-constitutional keeps its special abort handling
     (returns `Result.ok` with partial results on abort)

5. Updated `pipeline.ts` to check `Result.isError` after
   each `fetchPage` call; on error, captures and breaks
   the sync loop while persisting cursor progress.

6. Added `adapters/utils.test.ts` covering all three
   shared utilities.

## Workstream B: Shared subprocess runner

### Problem
`pdf-utils.ts` and `extract-content.ts` had nearly identical
subprocess spawn/collect/timeout logic.

### Changes
1. Added `SubprocessError` to `lib/errors/tagged-errors.ts`.

2. Created `lib/subprocess.ts` with `spawnWorker` that
   handles spawn, stdin piping, stdout collection, timeout
   kill, and exit-code checking; returns
   `Result<string, SubprocessError>`.

3. Refactored `pdf-utils.ts` and `extract-content.ts` to
   use `spawnWorker`, mapping `SubprocessError` to their
   domain-specific error types at the boundary.

4. Added `lib/subprocess.test.ts` with echo and fail-exit
   fixture workers.

## Files changed

- `apps/api/src/lib/errors/tagged-errors.ts`
- `apps/api/src/handlers/case-law/ingestion/adapter.ts`
- `apps/api/src/handlers/case-law/ingestion/pipeline.ts`
- `apps/api/src/handlers/case-law/ingestion/adapters/utils.ts` (new)
- `apps/api/src/handlers/case-law/ingestion/adapters/utils.test.ts` (new)
- `apps/api/src/handlers/case-law/ingestion/adapters/cz-regional.ts`
- `apps/api/src/handlers/case-law/ingestion/adapters/cz-supreme.ts`
- `apps/api/src/handlers/case-law/ingestion/adapters/cz-supreme-admin.ts`
- `apps/api/src/handlers/case-law/ingestion/adapters/cz-constitutional.ts`
- `apps/api/src/handlers/case-law/ingestion/adapters/sk-courts.ts`
- `apps/api/src/handlers/case-law/ingestion/adapters/pl-courts.ts`
- `apps/api/src/lib/subprocess.ts` (new)
- `apps/api/src/lib/subprocess.test.ts` (new)
- `apps/api/src/lib/__fixtures__/echo-worker.ts` (new)
- `apps/api/src/lib/__fixtures__/fail-worker.ts` (new)
- `apps/api/src/handlers/files/pdf-utils.ts`
- `apps/api/src/lib/search/extract-content.ts`

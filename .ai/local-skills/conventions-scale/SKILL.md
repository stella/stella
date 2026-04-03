---
name: conventions-scale
description: 'Apply when making architectural decisions, designing new endpoints, or adding database tables.'
---

# Scalability Conventions

Apply when making architectural decisions, designing new endpoints,
or adding database tables.

## Principle

Never paint yourself into a corner. The architecture must support
Magic Circle scale (2,000–5,000+ lawyers, millions of documents)
without a rewrite.

- If the scalable solution costs roughly the same effort as the
  simple one, choose the scalable solution now.
- If real scalability requires significantly more work, the
  simple solution is fine, but it must be _replaceable_ without
  restructuring surrounding code. Isolate it behind an interface,
  a config flag, or a clean module boundary.

## What This Means in Practice

**Pagination and streaming.** Never return unbounded result sets.
Every list endpoint must accept `limit`/`cursor` (or
`limit`/`offset`). For file processing, prefer streaming over
loading entire files into memory.

**Tenant isolation.** Application-level filtering (via `SafeId`
and `workspaceAccessMacro`) is the current approach. Do not
introduce patterns that would prevent adding PostgreSQL RLS
later: always filter by tenant ID in the query itself, never
fetch-then-check in application code.

**Stateless API processes.** Keep the Elysia server stateless so
it can run behind a load balancer with N replicas. No in-process
singletons that hold mutable state (caches, queues, locks).
Background work should be delegable to a separate worker or
queue consumer.

**Resource limits as configuration.** Limits (entity count,
property count, file size) must never be magic numbers scattered
in handlers. Define them in `lib/limits.ts`.

**AI provider abstraction.** Do not hardcode a single AI
provider in business logic. The provider should be selectable
via configuration.

**Indexes.** When adding a column used in `WHERE`, `ORDER BY`,
or `JOIN`, add an index in the same migration. Composite indexes
lead with the tenant-scoping column.

**Connection pooling.** Avoid long-held transactions; keep
transactions as short as possible. Design for an external pooler
(PgBouncer).

## Known Scale Gaps (acceptable today, tracked for later)

New code must not make these worse:

- No session caching (session lookups hit DB every request)
- No granular RBAC (workspace-level only)
- Frontend entity table has no virtualization or server pagination
- Random nanoid PKs (prefer ULIDs for new high-volume tables)

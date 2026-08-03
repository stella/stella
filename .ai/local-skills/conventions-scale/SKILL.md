---
name: conventions-scale
description: 'Apply when making architectural decisions, designing endpoints or workers, adding database tables, or changing data-volume behavior.'
---

# Scalability Conventions

Apply when making architectural decisions, designing endpoints or workers,
adding database tables, or changing data-volume behavior.

## Principle

Design for 2,000–5,000+ lawyers and millions of documents without requiring a
rewrite. Choose the scalable shape when it costs roughly the same. When it is
materially more expensive, isolate the simpler implementation behind a clear
contract so callers do not depend on its limitations.

## Required Shape

**Bounded reads.** Never return or scan an unbounded growing collection in a
request or repair job. List endpoints accept a normalized limit and opaque
cursor and return `Page<T>` from `apps/api/src/lib/pagination.ts`:
`{ items, nextCursor, limit }`. Offset pagination, `totalCount`, and unbounded
lists require explicit justification.

**Tenant isolation.** Stella already uses PostgreSQL RLS plus query-level
authorization. Workspace reads and writes go through authorized `scopedDb`
and include the tenant boundary in the query. `SafeId` and handler permission
checks complement RLS; none replaces the others. Root DB access is reserved
for demonstrated system-level operations with an explicit deny-by-default
policy.

**Stateless services.** API processes must work behind a load balancer with N
replicas. Do not depend on process-local mutable state for ownership, queues,
locks, required caches, or progress. Use durable queues, database leases,
compare-and-set transitions, and external caches where appropriate.

**Bounded background work.** Workers use durable checkpoints, deterministic
job identity, bounded concurrency, backpressure, and per-item failure records.
A retry or overlapping run must converge instead of duplicating effects.

**Streaming and batching.** Stream large files and exports; do not buffer them
entirely in memory. Batch database and remote operations and avoid per-row
network/query fan-out. Put explicit ceilings on batch size, payload size,
parallelism, retries, and execution time.

**Configuration-owned limits.** Growing-domain limits live in the owning
slice's named configuration or shared limit primitives, not as scattered magic
numbers. Defaults, hard ceilings, and normalized server-applied values must be
distinguishable.

**Indexes and access paths.** Add an index with every new request-path filter,
sort, or join; lead composite indexes with tenant scope. Check the query plan
for large-table or high-frequency paths rather than inferring performance from
the schema.

**Short transactions.** Keep external I/O outside transactions and design for
an external pooler. Long-running workflows persist progress between short
transactions.

**Replaceable providers.** AI, search, object storage, email, conversion, and
connector providers stay behind typed boundaries. Business logic must not
depend on one provider's model names, pagination quirks, or retry semantics.

## Evidence Before Exceptions

Do not keep a hand-maintained list of today's scale gaps in this skill; it
becomes stale. Inspect live baselines and code instead:

- `bun scripts/perf-hotspots.ts` for current network/query debt;
- affected query plans and table cardinality for database work;
- `scripts/typecheck-baseline.ts` for type-instantiation growth;
- bundle and route network baselines for frontend changes.

When accepting a temporary limitation, record its bound, the replacement
boundary, the signal that triggers migration, and the strongest guard that
prevents new code from making it worse.

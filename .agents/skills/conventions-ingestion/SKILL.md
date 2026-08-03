---
name: conventions-ingestion
description: Apply when building or reviewing external ingestion, imports, connector polling, webhooks, extraction workers, sync cursors, checkpoints, or repair jobs. Enforces replay safety, idempotency, durable progress, and bounded recovery.
---

# Replay-Safe Ingestion Conventions

Apply to any workflow that turns external or asynchronous input into durable
stella state: paginated imports, connector sync, webhooks, file extraction,
queue workers, migrations, and repair scans.

## Target Property

A retry, duplicate delivery, worker restart, or overlapping run must converge
to the same durable state as one successful run. Idempotency is one ingredient;
replay safety also requires correct checkpoint ordering, durable retries, and
protection from stale work.

## Required Design

1. **Stable identity.** Give every source item a stable, tenant-scoped identity.
   Enforce it with a database unique constraint whose leading columns preserve
   the tenant or source boundary. Do not rely on a hash collision check alone.
2. **Idempotent persistence.** Upsert, claim, or transition by stable identity.
   Reapplying the same input must not duplicate rows, counters, notifications,
   or other effects.
3. **Explicit outcomes.** Distinguish terminal outcomes (applied, unchanged,
   deliberately rejected) from retryable failures. A skipped item is terminal
   only when losing it is intentional and auditable.
4. **Checkpoint last.** Advance a cursor, watermark, or checkpoint only after
   every earlier item is terminal or has a durable retry record. On an
   ambiguous failure, hold the old checkpoint and replay.
5. **Atomic database batches.** For database-only work, persist the items and
   checkpoint in one short transaction with
   `commitReplaySafeIngestionBatch` from
   `apps/api/src/lib/replay-safe-ingestion.ts`.
6. **External side effects.** Object storage, search indexes, email, and remote
   APIs cannot join the database transaction. Make the database record the
   source identity/fingerprint and retry state first; use deterministic object
   keys or provider idempotency keys. Persist the cursor only after all page
   work is durable.
7. **Compare-and-set cursors.** Capture the cursor loaded at run start and
   require it in the checkpoint update. A stale run must return the persisted
   winner, never overwrite newer progress. Public corpus ingestion uses
   `advanceCorpusIngestionCheckpoint` from
   `apps/api/src/lib/corpus-ingestion-checkpoint.ts`.
8. **Stale-work protection.** Mutable inputs need a source version or content
   fingerprint. A late worker must compare the claimed version before
   overwriting newer state. AI outputs also include schema, model, prompt, and
   parser versions in their identity/provenance.
9. **Durable execution.** Do not rely on detached promises or process memory
   for required work. Use a durable queue/outbox and deterministic job
   identity. Add a bounded repair scan when enqueue and commit cannot be
   atomic.
10. **Bounded recovery.** Repair scans and list reads use cursor pagination and
    configured limits. Workers remain stateless and safe under concurrency.
11. **Owned schema.** The vertical slice owns its source, item, attempt, and
    failure tables. Shared code provides transaction and identity primitives,
    not a cross-domain ingestion framework.
12. **Bounded external calls.** Every remote request has an explicit timeout,
    bounded retry policy with jitter, provider-aware rate limiting, and a
    maximum concurrency. Persist retry state; do not hold a database
    transaction while waiting on the provider.
13. **Poison-item isolation.** One malformed or permanently rejected item must
    not stall an entire source forever. Persist the item identity, classified
    terminal/retryable outcome, sanitized error context, and operator-visible
    repair path before allowing later progress.

## Checkpoint Boundary

Direct Drizzle writes to `syncCursor` are banned by
`no-direct-ingestion-checkpoint-write`. Public corpus cursors go through
`advanceCorpusIngestionCheckpoint`; database-only batches keep the write inside
the `persistCheckpoint` callback passed to `commitReplaySafeIngestionBatch`.
The lint rule enforces the visible boundary; it does not prove that preceding
external effects are durable.

## Verification

Test the behavior that types and lint cannot prove:

- replay the same batch and assert the same fixed point;
- fail item persistence and assert the checkpoint does not advance;
- fail checkpoint persistence and assert database item writes roll back;
- deliver duplicates concurrently and assert one durable effect;
- crash after a remote side effect and before acknowledgment, then replay;
- finish stale work after a newer version and assert it cannot overwrite;
- leave an enqueue gap and assert the bounded repair scan finds it;
- exhaust the retry budget for one poison item and assert later items still
  reach a durable terminal state without silently dropping the failure;
- overlap two workers at the provider concurrency limit and assert calls stay
  bounded and the persisted winner cannot be overwritten.

Prefer invariant and state-machine tests over one example retry.

## Existing References

- Upload finalization: `apps/api/src/handlers/uploads/update.ts`
- Case-law ingestion: `apps/api/src/handlers/case-law/ingestion/pipeline.ts`
- Legislation ingestion: `apps/api/src/handlers/legislation/ingestion.ts`
- Hosted usage webhook deduplication:
  `apps/api/src/lib/hosted-usage-provider/webhook-store.ts`

These are examples, not blanket proof: audit each new side effect and
checkpoint independently.

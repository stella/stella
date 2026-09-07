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
14. **Accounted-for source fields.** Every field a source states on a page the
    adapter already fetches is stored, or excluded with the reason. See below.

## Checkpoint Boundary

Direct Drizzle writes to `syncCursor` are banned by
`no-direct-ingestion-checkpoint-write`. Public corpus cursors go through
`advanceCorpusIngestionCheckpoint`; database-only batches keep the write inside
the `persistCheckpoint` callback passed to `commitReplaySafeIngestionBatch`.
The lint rule enforces the visible boundary; it does not prove that preceding
external effects are durable.

## Source-Field Inventory

A field an adapter never noticed is indistinguishable from one it decided to
leave. Case-law adapters therefore declare what their source states, and the
declaration is part of the contract: `SourceAdapter.sourceFields` is required,
so an adapter without one does not compile.

An inventory has three parts, in the adapter beside the readers it mirrors:

- `SOURCE_FIELDS`, the list of names the source labels on the per-decision
  pages this adapter parses, `as const`;
- a disposition map written
  `as const satisfies Record<<that union>, SourceFieldDisposition>`, so the map
  is total by type and a new name without a decision does not compile. Each
  entry is `{ disposition: "stored", target }` (a metadata key, a result
  field, the parsed document, or the row's identity), or
  `{ disposition: "excluded", reason }`, where the reason says what the field
  is and why the row does not carry it. "Not read today" is not a reason;
  duplicate of a stored field, derived elsewhere, no field on the row, and data
  minimization are;
- `listSourceFields(payload)`, which reads a page back and answers what the
  publisher labelled on it.

`source-field-inventory.test.ts` drives every registered adapter from the
registry: each enrolled adapter's fixture goes through its own
`listSourceFields`, every name that comes out must be in the map, and every
field the map stores must be on the decision built from that fixture, at the
target the disposition names. A field on the page that is in neither set fails
with its name.

Enrolment is a ratchet. `PENDING_SOURCE_FIELD_INVENTORY` is the one sanctioned
way to not have an inventory, and
`adapters/source-field-inventory-baseline.json` lists exactly which adapters
use it. The suite fails when a pending adapter is missing from the baseline and
when a baseline entry has since enrolled, so the set only shrinks. To enrol
one: declare the three parts above, add a fixture to the conformance suite, and
delete the adapter's line from the baseline.

Refresh a fixture from the live page when the source changes. The suite
certifies the adapter against the page it is given, so a fixture that stopped
matching the publisher certifies nothing.

### Raw Holds Every Fetched Response

An inventory decides what is read; the stored raw decides what can still be
read later. Where a source serves one decision across several responses (a
detail page beside the document), store all of them, with
`encodeSourceRawEnvelope` and `SOURCE_RAW_ENVELOPE_CONTENT_TYPE`, naming each
part by its role. A raw that holds only the page the parser read makes a field
captured later unrecoverable for every stored row: replay can only re-read what
was kept.

`reparseStoredRaw` decodes with `decodeSourceRawEnvelope` and handles `null`,
which is what a row stored before its adapter had an envelope reads as. Bump
the adapter's entry in `PARSER_VERSIONS` when the replay's output changes, and
state in the pull request what a replay does and does not backfill: rows stored
before the change hold what they held, and only a re-crawl adds to them.

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
  bounded and the persisted winner cannot be overwritten;
- read a source fixture back through the adapter's own `listSourceFields` and
  assert every field it states is stored or excluded with a reason.

Prefer invariant and state-machine tests over one example retry.

## Existing References

- Upload finalization: `apps/api/src/handlers/uploads/update.ts`
- Case-law ingestion: `apps/api/src/handlers/case-law/ingestion/pipeline.ts`
- Legislation ingestion: `apps/api/src/handlers/legislation/ingestion.ts`
- Hosted usage webhook deduplication:
  `apps/api/src/lib/hosted-usage-provider/webhook-store.ts`

These are examples, not blanket proof: audit each new side effect and
checkpoint independently.

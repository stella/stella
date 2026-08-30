# Data Retention and Deletion Policy

**Owner:** Engineering
**Last reviewed:** 2026-07-10
**Review cadence:** Annual

## Purpose

Define how Stella retains and deletes data to comply with
data-protection obligations and honour user deletion requests.
When data is deleted, it is actually deleted: Stella does not
use soft deletes.

## Scope

All user-generated data stored in the PostgreSQL database and
S3 object storage: workspaces, entities, files, properties,
views, and associated metadata.

## Principles

<!-- evidence: retention-hard-delete -->

1. **Hard deletes only.** The schema contains no `deletedAt`,
   `isDeleted`, or soft-delete columns. When a user or
   administrator deletes a resource, the corresponding rows
   and objects are permanently removed.

2. **Cascade by design.** Foreign key constraints in the modular
   database schema (`apps/api/src/db/schema/`) enforce
   referential integrity during deletion. Parent resources
   cascade-delete their children automatically.

3. **Storage cleanup.** Deletion handlers remove referenced S3 objects
   and database rows rather than leaving inaccessible objects behind.
   Cross-store deletion uses durable cleanup records and bounded
   reconciliation because object storage cannot join a database transaction.

## Deletion flows

### Entity deletion

Handler: `apps/api/src/handlers/entities/delete.ts`

1. Query all files referenced by the entity's versions.
2. Within one database transaction, record the deduplicated S3 keys in a
   durable cleanup request and delete the entity row. Cascade FKs remove
   `entityVersions`, `fields`, and `justifications`.
3. After commit, dispatch the cleanup request to a worker. The worker deletes
   S3 keys with bounded concurrency. Each repair pass scans a bounded batch;
   durable retry scheduling with capped backoff continues until storage cleanup
   succeeds.

### Property deletion

Handler: `apps/api/src/handlers/properties/delete.ts`

1. Delete the property row. Cascade FKs remove dependent
   `fields` and `propertyDependencies`.
2. If other properties depend on the target (restrict FK),
   the delete fails with a 400 error, preventing data
   corruption.

### View deletion

Handler: `apps/api/src/handlers/views/delete-by-id.ts`

1. Check that at least one other view exists in the
   workspace (business rule).
2. Hard-delete the view row with a `workspaceId` guard.

### Workspace deletion

Handler: `apps/api/src/handlers/workspaces/delete.ts`

1. Reauthorize the actor, lock the workspace, and set its status to
   `"deleting"` in the transaction that owns the deletion.
2. Record all referenced object keys in durable cleanup requests and transfer
   any in-flight exact-key writes to the cleanup reconciler.
3. In the same transaction, remove restrictive and derived rows, prune
   retained context references, delete the workspace row, and record the audit
   event. Cascade FKs remove workspace-owned content.
4. After commit, dispatch a bounded prefix of cleanup requests. Durable
   reconciliation owns eventual object deletion if dispatch or storage is
   temporarily unavailable.

### Upload failure cleanup

Handler family: `apps/api/src/handlers/uploads/`

If the database transaction fails after an S3 object has been
written, the orphaned S3 object is immediately deleted in the
error handler.

### Template deletion

Handler: `apps/api/src/handlers/templates/delete.ts`

1. Collect the current and historical template object keys.
2. Delete the deduplicated S3 keys with bounded concurrency.
3. Delete the template row and record the audit event in one database
   transaction. Cascade FKs remove its version rows.

## S3 object lifecycle

- **ACL:** `private` (no public access).
- **Deletion method:** Bun `S3Client.delete()`, issued with at most
  50 object deletions in flight.
- **Idempotency:** Repeated deletion of an absent object is treated as a
  successful cleanup by supported S3-compatible providers.
- **Ordering:** Entity, workspace, and organization teardown records durable
  cleanup work in the same transaction as the database delete. Object cleanup
  follows commit because object storage cannot participate in the PostgreSQL
  transaction; bounded reconciliation retries incomplete effects.

## Retention periods

| Data type                           | Retention                                                    |
| ----------------------------------- | ------------------------------------------------------------ |
| Workspace content (entities, files) | Until explicitly deleted by the user or workspace owner      |
| User sessions                       | Managed by `better-auth`; sessions expire per configured TTL |
| Application logs                    | Per hosting provider retention policy                        |

Stella does not impose minimum retention periods on user
content. Deletion is immediate and irreversible upon request.

## Enforcement

- Hard-delete behaviour is enforced by the absence of
  soft-delete columns in the schema.
- Cascade and restrict FK constraints are defined in
  `apps/api/src/db/schema/` and enforced by PostgreSQL.
- Deletion flows that own S3 objects await bounded cleanup before removing
  their database references.

## Review

This policy is reviewed annually or when new data types are
introduced. Changes to the deletion flow require review from
the schema owner per `CODEOWNERS`.

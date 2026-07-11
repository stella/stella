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
   Cross-store deletion is retriable when object removal fails; it is not
   a single atomic transaction, so operators must treat a later database
   failure as a reconciliation event.

## Deletion flows

### Entity deletion

Handler: `apps/api/src/handlers/entities/delete.ts`

1. Query all files referenced by the entity's versions.
2. Delete deduplicated S3 keys with bounded concurrency.
3. Within a database transaction: delete the entity row.
   Cascade FKs remove `entityVersions`, `fields`, and
   `justifications`. Orphaned `files` rows are then deleted
   explicitly.

### Property deletion

Handler: `apps/api/src/handlers/properties/delete-by-id.ts`

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

Handler: `apps/api/src/handlers/workspaces/delete-by-id.ts`

1. Set workspace status to `"deleting"`, which gates all
   new uploads and actor connections.
2. Query all files in the workspace.
3. Delete S3 objects with bounded concurrency.
4. Within a transaction:
   - Delete `propertyDependencies` targeting workspace
     properties (required because restrict FKs block cascade).
   - Delete all `entities` (cascades to versions, fields,
     justifications).
   - Delete the `workspaces` row (cascades to properties,
     views, remaining files).
5. If S3 deletion fails, revert status to `"active"` to
   allow retry.

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
- **Ordering:** Object cleanup currently precedes the database delete so
  an object-store failure leaves the database record available for retry.
  A later database failure requires reconciliation because object storage
  cannot participate in the PostgreSQL transaction.

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

import { expect, test } from "bun:test";

const source = await Bun.file(new URL("delete.ts", import.meta.url)).text();

test("commits the entity withdrawal fence before storage cleanup is dispatched", () => {
  const cleanupRequest = source.indexOf(
    "tx.insert(entityDeletionCleanupRequests)",
  );
  const deleteEntity = source.indexOf(".delete(entities)");
  const dispatch = source.indexOf(
    "await handoffCommittedEntityDeletionCleanup",
  );

  expect(cleanupRequest).toBeGreaterThan(-1);
  expect(deleteEntity).toBeGreaterThan(cleanupRequest);
  expect(dispatch).toBeGreaterThan(deleteEntity);
  expect(source).not.toContain("deleteS3Objects(");
});

test("transfers durable room objects before the entity cascade removes their pointers", () => {
  const roomRead = source.indexOf(".from(folioCollabRooms)");
  const roomLock = source.indexOf('.for("update")', roomRead);
  const entityRead = source.indexOf(".from(entities)");
  const roomFiles = source.indexOf("collectFolioCollabStoredRoomFiles(room)");
  const deleteEntity = source.indexOf(".delete(entities)");

  expect(roomRead).toBeGreaterThan(-1);
  expect(roomLock).toBeGreaterThan(roomRead);
  expect(entityRead).toBeGreaterThan(roomLock);
  expect(roomFiles).toBeGreaterThan(roomRead);
  expect(deleteEntity).toBeGreaterThan(roomFiles);
});

// OCR run identity includes the entity version and field, so one long-lived
// document can outgrow any fixed ceiling. Rejecting the deletion instead would
// make that entity and its stored data permanently undeletable.
test("no longer caps how many derivatives one deletion may capture", () => {
  expect(source).toContain("await forEachOcrDerivativePage(");
  expect(source).not.toContain("entityDeletionOcrDerivativesMax");
  expect(source).not.toContain("Delete fewer documents at a time");
});

// The bounded inline hand-off is covered directly in
// entity-deletion-cleanup-handoff.test.ts; this only pins that the handler
// routes through it rather than fanning out one call per committed page.
test("routes cleanup dispatch through the bounded hand-off", () => {
  expect(source).toContain("handoffCommittedEntityDeletionCleanupBatch(");
  expect(source).not.toContain("Promise.all(");
});

test("deletes ingested message children and collects their files and derivatives", () => {
  expect(source).toContain("lockWorkspacesForEntityCap(tx, [workspaceId])");
  expect(source).toContain("inArray(entities.parentId, messageIds)");
  expect(source).toContain(
    ".limit(MAX_MESSAGE_ATTACHMENT_CHILDREN_PER_DELETE + 1)",
  );
  expect(source).toContain(
    "lockedAttachmentEntities.length >\n        MAX_MESSAGE_ATTACHMENT_CHILDREN_PER_DELETE",
  );
  expect(source).toContain("...lockedAttachmentEntities.map(({ id }) => id)");
  expect(source).toContain("excludedEntityIds: entityIdsToDelete");
  expect(source).toContain(
    "inArray(documentProcessingRuns.entityId, entityIdsToDelete)",
  );
  expect(source).toContain("inArray(entities.id, entityIdsToDelete)");

  // The delete mutation's RETURNING rows feed both the per-entity audit events
  // and the non-Postgres search cleanup, so attachment children follow the same
  // state-change and file-cleanup paths as the ingested message itself.
  const deleteMutation = source.indexOf(".delete(entities)");
  const auditEvents = source.indexOf("deleted.map((entity) => ({");
  const searchCleanup = source.indexOf("for (const entity of deletedEntities)");
  expect(auditEvents).toBeGreaterThan(deleteMutation);
  expect(searchCleanup).toBeGreaterThan(deleteMutation);
});

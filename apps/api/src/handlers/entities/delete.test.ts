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

test("records the canonical file field in the deletion snapshot", () => {
  const fieldSelect = source.indexOf("id: fields.id");
  const fieldOrder = source.indexOf(".orderBy(asc(fields.id))", fieldSelect);
  const firstFileGuard = source.indexOf(
    "currentFileByEntityId.has(entityId)",
    fieldOrder,
  );

  expect(fieldSelect).toBeGreaterThan(-1);
  expect(fieldOrder).toBeGreaterThan(fieldSelect);
  expect(firstFileGuard).toBeGreaterThan(fieldOrder);
});

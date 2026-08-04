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

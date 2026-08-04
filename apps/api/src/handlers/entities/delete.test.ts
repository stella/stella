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
test("pages OCR derivative cleanup instead of capping how much may be deleted", () => {
  expect(source).toContain("await forEachOcrDerivativePage(");
  expect(source).not.toContain("entityDeletionOcrDerivativesMax");
  expect(source).not.toContain("Delete fewer documents at a time");
});

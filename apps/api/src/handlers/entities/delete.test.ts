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

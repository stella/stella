import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/delete.ts`).text();

describe("template deletion storage cleanup", () => {
  test("commits a durable cleanup request instead of deleting objects before rows", () => {
    const recordCleanup = source.indexOf(
      "tx.insert(templateDeletionCleanupRequests)",
    );
    const deleteTemplate = source.indexOf(".delete(templates)");

    expect(recordCleanup).toBeGreaterThan(-1);
    expect(deleteTemplate).toBeGreaterThan(recordCleanup);
    expect(source).not.toContain("deleteS3Keys(");
  });
});

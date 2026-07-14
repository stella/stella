import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readHandler = (name: string) =>
  readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8");

describe("style set storage integrity", () => {
  test("commits row deletion before removing stored packages", () => {
    const source = readHandler("delete");
    const rowDelete = source.indexOf(".delete(styleSets)");
    const storageDelete = source.indexOf("getS3().delete(s3Key)");

    expect(rowDelete).toBeGreaterThan(-1);
    expect(storageDelete).toBeGreaterThan(rowDelete);
  });

  test("persists replacement cleanup state before deleting the old package", () => {
    const source = readHandler("replace");
    const persistCleanupKey = source.indexOf("cleanupS3Key: locked.s3Key");
    const storageDelete = source.indexOf("getS3().delete(replaced.oldS3Key)");
    const clearCleanupKey = source.indexOf(
      ".set({ cleanupS3Key: null })",
      storageDelete,
    );

    expect(persistCleanupKey).toBeGreaterThan(-1);
    expect(storageDelete).toBeGreaterThan(persistCleanupKey);
    expect(clearCleanupKey).toBeGreaterThan(storageDelete);
  });

  test("awaits rejected import cleanup", () => {
    const source = readHandler("create");
    const rejectedCleanup = source.indexOf(
      "Could not clean up the rejected style set package.",
    );

    expect(rejectedCleanup).toBeGreaterThan(-1);
    expect(source.lastIndexOf("await Result.tryPromise")).toBeLessThan(
      rejectedCleanup,
    );
  });
});

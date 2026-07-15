import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readHandler = (name: string) =>
  readFileSync(new URL(`${name}.ts`, import.meta.url), "utf-8");

describe("style set storage integrity", () => {
  test("persists a deletion tombstone until stored packages are removed", () => {
    const source = readHandler("delete");
    const tombstone = source.indexOf(".set({ deletedAt })");
    const rowDelete = source.indexOf(".delete(styleSets)");
    const storageDelete = source.indexOf("getS3().delete(s3Key)");

    expect(tombstone).toBeGreaterThan(-1);
    expect(storageDelete).toBeGreaterThan(tombstone);
    expect(rowDelete).toBeGreaterThan(storageDelete);
  });

  test("retains replaced packages until their download URLs expire", () => {
    const source = readHandler("storage");
    const persistCleanupKey = source.indexOf("cleanupS3Key: locked.s3Key");
    const scheduleCleanup = source.indexOf("s3Key: replaced.oldS3Key");
    const clearCleanupKey = source.indexOf(
      ".set({ cleanupS3Key: null })",
      scheduleCleanup,
    );

    expect(persistCleanupKey).toBeGreaterThan(-1);
    expect(scheduleCleanup).toBeGreaterThan(persistCleanupKey);
    expect(clearCleanupKey).toBeGreaterThan(scheduleCleanup);
    expect(source).not.toContain("getS3().delete(replaced.oldS3Key)");
  });

  test("awaits rejected import cleanup", () => {
    const source = readHandler("storage");
    const rejectedCleanup = source.indexOf(
      "Could not clean up the rejected style set package.",
    );
    const awaitedCleanup = source.lastIndexOf(
      "await Result.tryPromise",
      rejectedCleanup,
    );

    expect(rejectedCleanup).toBeGreaterThan(-1);
    expect(awaitedCleanup).toBeGreaterThan(-1);
    expect(awaitedCleanup).toBeLessThan(rejectedCleanup);
  });

  test("preserves a concurrently renamed style set during source replacement", () => {
    const storage = readHandler("storage");
    const replace = readHandler("replace");

    expect(storage).not.toContain(": locked.name;");
    expect(storage).toContain('replacementName.type === "replace"');
    expect(replace).toContain('replacementName: { type: "preserve" }');
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

describe("delete entity document-processing fence", () => {
  test("holds the entity lock from the running-run check through cleanup and delete", () => {
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete.ts"),
      "utf-8",
    );
    const transactionStart = source.indexOf("safeDb(async (tx) =>");
    const entityLock = source.indexOf('.for("update")', transactionStart);
    const runningCheck = source.indexOf(
      'documentProcessingRuns.status, "running"',
      entityLock,
    );
    const storageCleanup = source.indexOf("deleteS3Objects", runningCheck);
    const entityDelete = source.indexOf(".delete(entities)", storageCleanup);

    expect(transactionStart).toBeGreaterThan(-1);
    expect(entityLock).toBeGreaterThan(transactionStart);
    expect(runningCheck).toBeGreaterThan(entityLock);
    expect(storageCleanup).toBeGreaterThan(runningCheck);
    expect(entityDelete).toBeGreaterThan(storageCleanup);
    expect(source.split("safeDb(").length - 1).toBe(1);
  });
});

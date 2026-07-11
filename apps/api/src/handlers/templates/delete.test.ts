import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const source = readFileSync(
  nodePath.join(import.meta.dir, "delete.ts"),
  "utf-8",
);

describe("template deletion storage ordering", () => {
  test("awaits object cleanup before deleting the database row", () => {
    const storageDelete = source.indexOf("await deleteS3Keys");
    const databaseDelete = source.indexOf(".delete(templates)");

    expect(storageDelete).toBeGreaterThan(-1);
    expect(databaseDelete).toBeGreaterThan(storageDelete);
    expect(source).not.toContain(".delete(key).catch");
  });
});

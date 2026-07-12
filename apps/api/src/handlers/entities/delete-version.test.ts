import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

// Chain-of-custody class guard. A document version is legal evidence: it must
// never be hard-deleted, and its bytes must stay retained under legal hold.
// `delete-version.ts` tombstones the row (sets `deletedAt` + actor) instead of
// issuing a DB delete, and every read/list/restore/download path filters out
// tombstoned rows. These are source-level invariants so a future edit that
// reintroduces a destructive delete — or a new version read that forgets the
// filter — trips CI instead of silently shredding history.

const API_SRC = nodePath.resolve(import.meta.dir, "../..");

const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = nodePath.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) {
      continue;
    }
    // Tests may exercise raw deletes against a throwaway DB; only production
    // source is bound by the no-hard-delete invariant.
    if (entry.endsWith(".test.ts")) {
      continue;
    }
    acc.push(full);
  }
  return acc;
};

describe("delete-version chain-of-custody guard", () => {
  test("no production code hard-deletes an entity version", () => {
    const offenders = collectSourceFiles(API_SRC).filter((file) =>
      readFileSync(file, "utf8").includes("delete(entityVersions)"),
    );

    expect(offenders).toEqual([]);
  });

  test("delete-version tombstones the row instead of deleting it", () => {
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf8",
    );

    expect(source).not.toContain("delete(entityVersions)");
    expect(source).toContain("update(entityVersions)");
    expect(source).toContain("deletedAt: new Date()");
    expect(source).toContain("deletedBy: deletedByUserId");
    // The S3 objects are retained: the handler must not delete them.
    expect(source).not.toContain("deleteS3Objects");
  });

  test("every version read/list/restore/download path filters tombstones", () => {
    // Each file resolves or enumerates entity versions for content access; a
    // tombstoned version must be invisible and unreachable through all of them.
    const guardedReadPaths = [
      "handlers/entities/read-versions.ts",
      "handlers/entities/read-version-by-id.ts",
      "handlers/entities/restore-version.ts",
      "handlers/entities/check-stamp.ts",
      "handlers/entities/compare-versions.ts",
      "handlers/entities/compute-version-diff.ts",
      "handlers/entities/version-diff-sources.ts",
      "handlers/entities/translate.ts",
      "handlers/entities/query-entities.ts",
      "handlers/verify/resolve-auth.ts",
      "handlers/files/read-by-id.ts",
      "handlers/chat/tools/version-compare-tools.ts",
      "mcp/document-tools.ts",
      "lib/entity-filters.ts",
    ];

    const missing = guardedReadPaths.filter(
      (rel) =>
        !readFileSync(nodePath.join(API_SRC, rel), "utf8").includes(
          "deletedAt",
        ),
    );

    expect(missing).toEqual([]);
  });
});

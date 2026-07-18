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
      readFileSync(file, "utf-8").includes("delete(entityVersions)"),
    );

    expect(offenders).toEqual([]);
  });

  test("delete-version tombstones the row instead of deleting it", () => {
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf-8",
    );

    expect(source).not.toContain("delete(entityVersions)");
    expect(source).toContain("update(entityVersions)");
    expect(source).toContain("deletedAt: new Date()");
    expect(source).toContain("deletedBy: deletedByUserId");
    // The S3 objects are retained: the handler must not delete them.
    expect(source).not.toContain("deleteS3Objects");
  });

  test("validates live count and promotion under a FOR UPDATE entity lock", () => {
    // Concurrency guard. The live-version count and current-version promotion
    // must run inside the same transaction as the tombstone, serialized on the
    // owning entity row via `FOR UPDATE`. Two concurrent deletes that each read
    // the live count before mutating could otherwise both pass the "not the
    // last version" check and tombstone the final two live versions, or leave
    // currentVersionId pointing at a tombstone. Locking the entity row first
    // forces them one at a time.
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf-8",
    );

    // The entity row is the serialization point.
    expect(source).toContain('.for("update")');

    // Exactly one transaction: no separate pre-transaction read can validate
    // against a snapshot the mutation then races.
    expect(source.split("safeDb(").length - 1).toBe(1);

    // The lock and every validation live after the transaction opens.
    const txStart = source.indexOf("safeDb(async (tx) =>");
    expect(txStart).toBeGreaterThan(-1);
    expect(source.indexOf('.for("update")')).toBeGreaterThan(txStart);
    expect(
      source.indexOf("Cannot delete the only remaining version"),
    ).toBeGreaterThan(txStart);
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
        !readFileSync(nodePath.join(API_SRC, rel), "utf-8").includes(
          "deletedAt",
        ),
    );

    expect(missing).toEqual([]);
  });

  test("tombstoning a version cancels its open desktop edit sessions", () => {
    // An open desktop edit session anchored to the withdrawn version could
    // otherwise resume and re-download the version's bytes. Tombstoning must
    // cancel those sessions inside the same transaction as the version update.
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf-8",
    );

    expect(source).toContain("update(desktopEditSessions)");
    expect(source).toContain(
      "eq(desktopEditSessions.baseVersionId, params.versionId)",
    );
    expect(source).toContain('status: "cancelled"');
  });

  test("the desktop resume chokepoint refuses a tombstoned base version", () => {
    // readVersionDocxTarget is the single path that serves a base version's
    // bytes to a resuming desktop edit session. It must join entity_versions
    // and require deletedAt IS NULL, so a tombstoned base version is never
    // served regardless of session state (class guard for the cascade above).
    const source = readFileSync(
      nodePath.join(import.meta.dir, "desktop-edit-session-utils.ts"),
      "utf-8",
    );

    const readVersionTarget = source.slice(
      source.indexOf("export const readVersionDocxTarget"),
      source.indexOf("export const presignDocxFieldDownload"),
    );

    expect(readVersionTarget).toContain("innerJoin(entityVersions");
    expect(readVersionTarget).toContain("isNull(entityVersions.deletedAt)");
  });
});

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

  test("locks the sessions it cancels before the entity row (finalize's order)", () => {
    // Lock-order hierarchy (issue #1139): docx-edit advisory lock ->
    // desktop_edit_session rows -> entities row. This handler takes no advisory
    // lock, but it MUST lock the sessions it cancels BEFORE the entity row so it
    // agrees with finalize-desktop-edit-session, which locks the session row
    // (FOR UPDATE) and then the entity row. Locking the entity first here and
    // the sessions second (the cancel UPDATE) would invert finalize's order and
    // risk an ABBA deadlock between a concurrent delete and finalize.
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf-8",
    );

    const sessionLockIndex = source.indexOf(".from(desktopEditSessions)");
    const entityLockIndex = source.indexOf(".from(entities)");
    expect(sessionLockIndex).toBeGreaterThan(-1);
    expect(entityLockIndex).toBeGreaterThan(-1);
    // Sessions are locked before the entity row.
    expect(sessionLockIndex).toBeLessThan(entityLockIndex);

    // Two row-lock acquisitions: the session sweep, then the entity row.
    expect(source.split('.for("update")').length - 1).toBe(2);
  });

  test("every entityVersions read filters tombstones or is a reviewed exception", () => {
    // Discovery sweep (not an allowlist): enumerate every production read of
    // `entityVersions` and require each one to either carry a `deletedAt`
    // tombstone predicate, or be a reviewed exception justified below. A new
    // read that forgets the filter (the class of the withdrawn-version leak)
    // fails here — the guard finds the query itself, so it cannot be bypassed
    // by adding an unlisted file.

    // Every occurrence of these opens an `entityVersions` read. `deletedAt` must
    // appear within QUERY_WINDOW lines after the match (the where clause).
    const READ_PATTERNS = ["from(entityVersions)", "query.entityVersions."];
    const QUERY_WINDOW = 24;
    // Comments/aliases that justify an exception may sit just above the read.
    const CONTEXT_BEFORE = 8;

    // Reviewed exceptions: reads that legitimately span tombstoned rows. Each is
    // keyed by its path relative to API_SRC; `anchor` is a unique substring of
    // the specific query (so the exemption cannot silently cover a sibling read)
    // and must actually be present (stale entries fail). These are write/GC or
    // metadata-only paths, never content served back to a caller.
    const REVIEWED_EXCEPTIONS: Record<
      string,
      readonly { anchor: string; reason: string }[]
    > = {
      "handlers/entities/delete.ts": [
        {
          anchor: "inArray(entities.id, body.entityIds)",
          reason:
            "Whole-entity delete GC: enumerates every version (incl. tombstoned) to collect S3 file refs to release; sees no field content.",
        },
      ],
      "handlers/workspaces/delete-by-id.ts": [
        {
          anchor: "workspaceEntityVersionIds",
          reason:
            "Workspace-deletion GC: a workspace-wide file-ref sweep that must include tombstoned versions so their bytes are also cleaned up.",
        },
      ],
      "handlers/entities/restore-version.ts": [
        {
          anchor: "nextVersionNumber = (latestVersion",
          reason:
            "Version-number allocation: MAX(versionNumber) deliberately spans tombstones so a restore never reuses a withdrawn version's number; reads versionNumber only.",
        },
      ],
      "handlers/entities/upload-version.ts": [
        {
          anchor: "currentVersion.fields.find",
          reason:
            "New-version upload: reads the current version's fields to carry them forward. currentVersionId is invariant-live (tombstoning promotes it off a withdrawn row).",
        },
        {
          anchor: "freshCurrentVersion.fields.find",
          reason:
            "Same carry-forward read, re-taken under the entity-cap lock; currentVersionId is invariant-live.",
        },
      ],
      "handlers/uploads/entity-version.ts": [
        {
          anchor: "freshCurrentVersionId",
          reason:
            "Presigned-upload finalize: reads the locked current version's fields to carry forward into a new version; currentVersionId is invariant-live.",
        },
      ],
      "handlers/entities/finalize-desktop-edit-session.ts": [
        {
          anchor: "editSession.baseVersionId",
          reason:
            "Desktop-edit finalize: reads the base version to merge into a new version. Tombstoning cancels open sessions, so an open session's base is live; write path, not a content read.",
        },
      ],
      "handlers/entities/open-desktop-edit-session.ts": [
        {
          anchor: "existingSession.baseVersionId",
          reason:
            "Session-resume staleness check: reads versionNumber only. The byte-serving chokepoint (readVersionDocxTarget) separately requires deletedAt IS NULL.",
        },
      ],
      "handlers/folio-collab/finalize.ts": [
        {
          anchor: "sessionPreview.baseVersionId",
          reason:
            "Collab finalize: reads the base version to build the merge target on a write path, gated by an open collab session.",
        },
      ],
    };

    const toPosix = (file: string) =>
      nodePath.relative(API_SRC, file).split(nodePath.sep).join("/");

    const uncovered: string[] = [];
    const matchedExceptions = new Set<string>();

    for (const file of collectSourceFiles(API_SRC)) {
      const rel = toPosix(file);
      const lines = readFileSync(file, "utf-8").split("\n");
      const fileExceptions = REVIEWED_EXCEPTIONS[rel] ?? [];

      for (const [index, line] of lines.entries()) {
        if (!READ_PATTERNS.some((pattern) => line.includes(pattern))) {
          continue;
        }

        // Forward-only window for the tombstone predicate (drizzle's where
        // clause follows `from`/`query`).
        const guardWindow = lines.slice(index, index + QUERY_WINDOW + 1);
        if (guardWindow.some((l) => l.includes("deletedAt"))) {
          continue;
        }

        const contextWindow = lines
          .slice(Math.max(0, index - CONTEXT_BEFORE), index + QUERY_WINDOW + 1)
          .join("\n");
        const exception = fileExceptions.find((e) =>
          contextWindow.includes(e.anchor),
        );
        if (exception) {
          matchedExceptions.add(`${rel}::${exception.anchor}`);
          continue;
        }

        uncovered.push(`${rel}:${index + 1}`);
      }
    }

    // A read with neither a tombstone predicate nor a reviewed exception is a
    // potential withdrawn-version leak.
    expect(uncovered).toEqual([]);

    // No stale exceptions: every declared exception must match a real read.
    const declared = Object.entries(REVIEWED_EXCEPTIONS).flatMap(
      ([rel, entries]) => entries.map((e) => `${rel}::${e.anchor}`),
    );
    const staleExceptions = declared.filter(
      (key) => !matchedExceptions.has(key),
    );
    expect(staleExceptions).toEqual([]);
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

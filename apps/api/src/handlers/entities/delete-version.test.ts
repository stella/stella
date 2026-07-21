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

  test("locks each session kind before the entity row (finalize's order)", () => {
    // Lock-order hierarchy (issue #1139): docx-edit advisory lock ->
    // edit-session rows -> entities row. This handler takes no advisory lock,
    // but it MUST lock the sessions it cancels BEFORE the entity row so it
    // agrees with finalize-desktop-edit-session, which locks the session row
    // (FOR UPDATE) and then the entity row. Locking the entity first here and
    // the sessions second (the cancel UPDATE) would invert finalize's order and
    // risk an ABBA deadlock between a concurrent delete and finalize.
    const source = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf-8",
    );

    // Bind each FOR UPDATE to the query it protects: the lock is the first
    // `.for("update")` that follows that table's `.from(...)`.
    const lockIndexFor = (fromClause: string): number => {
      const fromIndex = source.indexOf(fromClause);
      if (fromIndex === -1) {
        return -1;
      }
      return source.indexOf('.for("update")', fromIndex);
    };

    const desktopSessionLock = lockIndexFor(".from(desktopEditSessions)");
    const collabSessionLock = lockIndexFor(".from(folioCollabSessions)");
    const entityLock = lockIndexFor(".from(entities)");

    // Every lock is actually acquired (its .from(...) is followed by FOR UPDATE).
    expect(desktopSessionLock).toBeGreaterThan(-1);
    expect(collabSessionLock).toBeGreaterThan(-1);
    expect(entityLock).toBeGreaterThan(-1);

    // Both session kinds are locked before the entity row.
    expect(desktopSessionLock).toBeLessThan(entityLock);
    expect(collabSessionLock).toBeLessThan(entityLock);
  });

  test("cancels every session kind anchored to the tombstoned version", () => {
    // Class-2 discovery guard: any table that anchors an edit session to a base
    // version (a base_version_id FK to entity_versions) must be cancelled in the
    // delete-version transaction, or a session could resume/seed and re-serve
    // the withdrawn version's bytes. Discover those tables from the schema so a
    // NEW session kind trips this test until delete-version withdraws it too.
    const schemaDir = nodePath.join(API_SRC, "db/schema");
    const schemaText = collectSourceFiles(schemaDir)
      .map((file) => readFileSync(file, "utf-8"))
      .join("\n");

    // Each `export const <name> = p.pgTable(...)` becomes one segment; keep the
    // ones that declare a base_version_id column (an edit session anchored to a
    // version) and read off the exported table name.
    const sessionTables = schemaText
      .split("export const ")
      .filter(
        (segment) =>
          segment.includes("p.pgTable") && segment.includes("base_version_id"),
      )
      .map((segment) => /^(\w+)/u.exec(segment)?.[1])
      .filter((name): name is string => name !== undefined);

    // Sanity: the two known session kinds are discovered.
    expect(sessionTables).toContain("desktopEditSessions");
    expect(sessionTables).toContain("folioCollabSessions");

    const deleteVersionSource = readFileSync(
      nodePath.join(import.meta.dir, "delete-version.ts"),
      "utf-8",
    );
    const uncancelled = sessionTables.filter(
      (table) => !deleteVersionSource.includes(`update(${table})`),
    );
    expect(uncancelled).toEqual([]);
  });

  test("no relational fields/cellMetadata read is keyed by entityVersionId", () => {
    // Class-1 guard (round 4). A relational `tx.query.{fields,cellMetadata,
    // entityVersionAiSummaries}.find*` cannot join entity_versions inline, so
    // keying one by entityVersionId is the exact TOCTOU shape behind the
    // withdrawn-version content leaks: resolve a live version in one query, then
    // read its content in a SEPARATE query keyed by that id. Such reads must
    // instead fold the content into the entity_versions query (`with:
    // { fields }`) or use a core join carrying `deletedAt IS NULL`. Banning the
    // shape outright makes the leak structurally impossible to reintroduce.
    const RELATIONAL_DEPENDENT_READS = [
      "query.fields.find",
      "query.cellMetadata.find",
      "query.entityVersionAiSummaries.find",
    ];

    const offenders: string[] = [];
    for (const file of collectSourceFiles(API_SRC)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      const rel = nodePath
        .relative(API_SRC, file)
        .split(nodePath.sep)
        .join("/");
      for (const [index, line] of lines.entries()) {
        if (!RELATIONAL_DEPENDENT_READS.some((p) => line.includes(p))) {
          continue;
        }
        // A relational `where: { entityVersionId: { ... } }` within the call.
        const window = lines.slice(index, index + 10).join("\n");
        if (window.includes("entityVersionId: {")) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
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
      "handlers/workspaces/delete.ts": [
        {
          anchor: "workspaceEntityVersionIds",
          reason:
            "Workspace-deletion GC: a workspace-wide file-ref sweep that must include tombstoned versions so their bytes are also cleaned up.",
        },
      ],
      "handlers/entities/version-utils.ts": [
        {
          anchor: "max(entityVersions.versionNumber)",
          reason:
            "Version-number allocator (nextEntityVersionNumber): MAX(versionNumber) deliberately spans tombstones so a new version never reuses a withdrawn number; reads versionNumber only, no content.",
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
      "handlers/entities/create-entity-version-from-buffer.ts": [
        {
          anchor: "freshCurrentVersionId } }",
          reason:
            "New-version write-back from an already-built buffer (the " +
            "edit_workspace_document chat tool): re-checks the locked " +
            "entity's currentVersionId exists before carrying its fields " +
            "forward. currentVersionId is invariant-live (tombstoning " +
            "promotes it off a withdrawn row), same as upload-version.ts's " +
            "identical carry-forward read.",
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

  test("restore-version re-checks source liveness under the entity lock", () => {
    // Write-side tombstone race. Restore clones a source version into a new
    // live version; if a concurrent delete tombstones the source mid-restore,
    // the clone would resurrect withdrawn content. The mutation transaction
    // must lock the entity row (serializing with delete-version) and re-verify
    // the source is still live before cloning.
    const source = readFileSync(
      nodePath.join(import.meta.dir, "restore-version.ts"),
      "utf-8",
    );

    const txStart = source.indexOf("safeDb(async (tx) =>");
    expect(txStart).toBeGreaterThan(-1);
    // The lock and the liveness recheck both live inside the mutation tx.
    expect(source.indexOf('.for("update")')).toBeGreaterThan(txStart);
    expect(source.indexOf("isNull(entityVersions.deletedAt)")).toBeGreaterThan(
      txStart,
    );
  });

  test("every entityVersions UPDATE gates on deletedAt or is a reviewed write", () => {
    // Write-side variant of the tombstone class: an UPDATE keyed by a version id
    // whose WHERE lacks a deletedAt predicate can land on a version tombstoned
    // between a pre-read and the write (label/description annotations were this
    // shape). Every `.update(entityVersions)` must carry a deletedAt predicate,
    // or set deletedAt (the tombstone writer itself), or be a reviewed
    // exception. The Class-1 sweep covered content READS; this covers writes.
    const UPDATE_WINDOW = 15;
    const REVIEWED_EXCEPTIONS: Record<
      string,
      { anchor: string; reason: string }
    > = {
      "handlers/entities/compute-version-diff.ts": {
        anchor: "diffWordsAdded",
        reason:
          "Derived diff-stats cache write on a freshly-finalized version; landing on a concurrently-tombstoned row is harmless because tombstoned versions are never read.",
      },
    };

    const offenders: string[] = [];
    const matchedExceptions = new Set<string>();
    for (const file of collectSourceFiles(API_SRC)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      const rel = nodePath
        .relative(API_SRC, file)
        .split(nodePath.sep)
        .join("/");
      for (const [index, line] of lines.entries()) {
        if (!line.includes(".update(entityVersions)")) {
          continue;
        }
        const window = lines.slice(index, index + UPDATE_WINDOW + 1).join("\n");
        // `deletedAt` in the window covers both a WHERE predicate (gated write)
        // and the tombstone writer's own `set({ deletedAt: ... })`.
        if (window.includes("deletedAt")) {
          continue;
        }
        const exception = REVIEWED_EXCEPTIONS[rel];
        if (exception && window.includes(exception.anchor)) {
          matchedExceptions.add(rel);
          continue;
        }
        offenders.push(`${rel}:${index + 1}`);
      }
    }

    expect(offenders).toEqual([]);
    const stale = Object.keys(REVIEWED_EXCEPTIONS).filter(
      (rel) => !matchedExceptions.has(rel),
    );
    expect(stale).toEqual([]);
  });

  test("version writers allocate via MAX(all), never a backward-movable pointer", () => {
    // Class guard: "allocator derived from a pointer that can move backwards".
    // Deriving the next number from current/base version + 1 reuses a
    // tombstoned latest version's number after a delete promotes
    // currentVersionId backward (no unique index on (entityId, versionNumber),
    // so the collision is a silent duplicate). Every writer must allocate via
    // nextEntityVersionNumber (MAX over ALL versions, including tombstoned).
    const utils = readFileSync(
      nodePath.join(API_SRC, "handlers/entities/version-utils.ts"),
      "utf-8",
    );
    const allocator = utils.slice(
      utils.indexOf("export const nextEntityVersionNumber"),
      utils.indexOf("export const buildVersionStamp"),
    );
    // The allocator counts tombstoned versions: MAX(versionNumber) with no
    // deletedAt predicate.
    expect(allocator).toContain("max(entityVersions.versionNumber)");
    expect(allocator).not.toContain("deletedAt");

    // No production code allocates a version number from a movable pointer + 1.
    const offenders = collectSourceFiles(API_SRC).filter((file) =>
      readFileSync(file, "utf-8").includes("versionNumber + 1"),
    );
    expect(offenders).toEqual([]);
  });
});

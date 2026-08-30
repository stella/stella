import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  bufferObjectCleanupIntents,
  entityDeletionCleanupRequests,
  pendingUploads,
} from "@/api/db/schema";

describe("pending upload recovery indexes", () => {
  test("the global stale-buffer sweep starts from claimed_at", () => {
    const recoveryIndex = getTableConfig(pendingUploads).indexes.find(
      (index) =>
        index.config.name === "pending_uploads_buffer_intent_recovery_idx",
    );

    expect(recoveryIndex).toBeDefined();
    expect(
      recoveryIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["claimed_at", "id"]);
    const recoveryPredicate = recoveryIndex?.config.where;
    expect(recoveryPredicate).toBeDefined();
    if (!recoveryPredicate) {
      return;
    }
    expect(new PgDialect().sqlToQuery(recoveryPredicate).sql).toContain(
      "IN ('scanning', 'failed')",
    );
  });
});

// ── Storage-erasure outboxes must reference nothing ─────────────────────
//
// Both tables below are the only surviving record of which S3 objects still
// have to be erased. Every S3 deletion in the codebase is key-driven from rows
// like these (`deleteS3Keys` in lib/files/utils.ts); nothing anywhere lists an
// S3 prefix, and the documents bucket expires only `tmp/` and `exports/` keys,
// never a finalized `{org}/{workspace}/{file}` key. So any FK that cascades
// deletes the erasure instructions while the objects still exist, and nothing
// can rediscover them.
//
// The assertion is on the whole set, not a count, so the failure message names
// the offending reference. Only `buffer_object_cleanup_intents` was guarded
// before, which is exactly how an org FK was proposed for the unguarded twin;
// covering both is the point.
//
// An ancestor reference here becomes correct only once that ancestor's
// deletion performs its own storage teardown. If you are here because you
// added one, add the teardown first.
const STORAGE_ERASURE_OUTBOXES = [
  bufferObjectCleanupIntents,
  entityDeletionCleanupRequests,
] as const;

describe("storage-erasure outboxes", () => {
  for (const table of STORAGE_ERASURE_OUTBOXES) {
    const config = getTableConfig(table);

    test(`${config.name} references no ancestor, so cleanup survives owner deletion`, () => {
      const references = config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        return `${getTableConfig(reference.foreignTable).name} (via ${reference.columns
          .map((column) => column.name)
          .join(", ")})`;
      });

      expect(references).toEqual([]);
    });
  }

  test("a cleanup request may name the organization instead of a matter", () => {
    // Organization deletion records templates, style-set packages, and chat
    // attachments, none of which sit under a matter. A NOT NULL here would
    // force a matter onto keys that never had one, and there is no honest
    // value to force.
    const workspaceColumn = getTableConfig(
      entityDeletionCleanupRequests,
    ).columns.find((column) => column.name === "workspace_id");

    expect(workspaceColumn?.notNull).toBe(false);
  });

  test("an exact-key tombstone may name an organization-scoped writer", () => {
    const workspaceColumn = getTableConfig(
      bufferObjectCleanupIntents,
    ).columns.find((column) => column.name === "workspace_id");

    expect(workspaceColumn?.notNull).toBe(false);
  });

  test("buffer object cleanup tombstones have a bounded scheduler index", () => {
    const scheduleIndex = getTableConfig(
      bufferObjectCleanupIntents,
    ).indexes.find(
      (index) => index.config.name === "buffer_object_cleanup_schedule_idx",
    );
    expect(
      scheduleIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["next_attempt_at", "id"]);
  });
});

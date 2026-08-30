import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import {
  bufferObjectCleanupIntents,
  emailIngestEffects,
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

  test("the email-ingest recovery sweep indexes persisted object keys", () => {
    const recoveryIndex = getTableConfig(pendingUploads).indexes.find(
      (index) =>
        index.config.name === "pending_uploads_email_ingest_recovery_idx",
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
    const predicateSql = new PgDialect().sqlToQuery(recoveryPredicate).sql;
    expect(predicateSql).toContain("email_ingest");
    expect(predicateSql).toContain("recoveryObjectKeys");
  });

  test("Outlook source identity is unique within its tenant and workspace", () => {
    const sourceIndex = getTableConfig(pendingUploads).indexes.find(
      (index) => index.config.name === "pending_uploads_email_source_uidx",
    );

    expect(sourceIndex?.config.unique).toBe(true);
    expect(
      sourceIndex?.config.columns
        .slice(0, 2)
        .map((column) => ("name" in column ? column.name : undefined)),
    ).toEqual(["organization_id", "workspace_id"]);
    const predicate = sourceIndex?.config.where;
    expect(predicate).toBeDefined();
    if (predicate) {
      const predicateSql = new PgDialect().sqlToQuery(predicate).sql;
      expect(predicateSql).toContain("email_ingest");
      expect(predicateSql).toContain("sourceKey");
    }
  });
});

describe("email ingest effect outbox", () => {
  const config = getTableConfig(emailIngestEffects);

  test("uses a deterministic effect identity and bounded recovery indexes", () => {
    expect(
      config.primaryKeys.at(0)?.columns.map((column) => column.name),
    ).toEqual(["source_upload_id", "entity_id", "kind"]);
    expect(config.indexes.map((index) => index.config.name)).toEqual([
      "email_ingest_effects_due_idx",
      "email_ingest_effects_processing_idx",
    ]);
  });

  test("binds claim and completion timestamps to their states", () => {
    expect(config.checks.map((check) => check.name)).toEqual([
      "email_ingest_effects_kind_check",
      "email_ingest_effects_status_check",
      "email_ingest_effects_attempt_count_check",
      "email_ingest_effects_claim_state_check",
      "email_ingest_effects_completion_state_check",
    ]);
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

  test("buffer object cleanup tombstones have a composite key and bounded scheduler index", () => {
    const config = getTableConfig(bufferObjectCleanupIntents);
    expect(
      config.primaryKeys.at(0)?.columns.map((column) => column.name),
    ).toEqual(["id", "object_key"]);
    const scheduleIndex = config.indexes.find(
      (index) => index.config.name === "buffer_object_cleanup_schedule_idx",
    );
    expect(
      scheduleIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["next_attempt_at", "id"]);
  });
});

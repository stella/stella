import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import {
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS,
  caseLawCorpusUploadIntents,
} from "@/api/db/schema";
import {
  corpusUploadCleanupDelayMs,
  planCorpusUploadIntentCleanup,
} from "@/api/lib/legal-search/case-law-corpus-upload-intents";

const source = readFileSync(
  new URL("case-law-corpus-upload-intents.ts", import.meta.url),
  "utf-8",
);
const redactionMigration = readFileSync(
  new URL(
    "../../../drizzle/20260731220000_case_law_redaction_fence/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const redactionIndexMigration = readFileSync(
  new URL(
    "../../../drizzle/20260801110000_case_law_redaction_audit_index/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const redactionBackfillTask = readFileSync(
  new URL(
    "../scheduler/tasks/case-law-redaction-tombstone-backfill.ts",
    import.meta.url,
  ),
  "utf-8",
);

describe("case-law corpus upload intents", () => {
  test("retain cleanup ownership without a decision foreign key and scan it bounded", () => {
    const config = getTableConfig(caseLawCorpusUploadIntents);
    const dueIndex = config.indexes.find(
      (index) =>
        index.config.name === "case_law_corpus_upload_intents_cleanup_due_idx",
    );
    const activeIndex = config.indexes.find(
      (index) =>
        index.config.name ===
        "case_law_corpus_upload_intents_active_decision_uidx",
    );
    const activeLeaseIndex = config.indexes.find(
      (index) =>
        index.config.name === "case_law_corpus_upload_intents_active_lease_idx",
    );

    expect(config.foreignKeys).toHaveLength(0);
    expect(
      dueIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["next_cleanup_at", "id"]);
    expect(config.policies.map((policy) => policy.name)).toEqual([
      "case_law_ingestion_access",
    ]);
    expect(activeIndex?.config.unique).toBe(true);
    expect(
      activeIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["decision_id"]);
    expect(config.columns.map((column) => column.name)).toContain(
      "lease_expires_at",
    );
    expect(
      activeLeaseIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["lease_expires_at", "id"]);
  });

  test("uses a discriminated active-to-cleanup lifecycle with capped retries", () => {
    expect(CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS).toEqual({
      ACTIVE: "active",
      CLEANUP: "cleanup",
    });
    expect(corpusUploadCleanupDelayMs(0)).toBe(60_000);
    expect(corpusUploadCleanupDelayMs(1)).toBe(120_000);
    expect(corpusUploadCleanupDelayMs(100)).toBe(24 * 60 * 60 * 1000);
  });

  test("locks and preflights before the external write, then retains failed writes", () => {
    const sharedLock = source.indexOf('.for("share")');
    const exclusiveLock = source.indexOf('.for("update")');
    const preflight = source.indexOf("await preflight(tx)");
    const write = source.indexOf("await write({");
    const failedWriteCleanup = source.indexOf(
      "enqueueCaseLawCorpusUploadIntentCleanup",
      write,
    );
    const skipLocked = source.indexOf("skipLocked: true");

    expect(sharedLock).toBeGreaterThan(-1);
    expect(exclusiveLock).toBeGreaterThan(sharedLock);
    expect(preflight).toBeGreaterThan(exclusiveLock);
    expect(write).toBeGreaterThan(preflight);
    expect(failedWriteCleanup).toBeGreaterThan(write);
    expect(skipLocked).toBeGreaterThan(-1);
    expect(source).toContain("active.leaseExpiresAt.getTime() > Date.now()");
  });

  test("keeps rollout tombstones synchronous and historical repair bounded", () => {
    expect(redactionMigration).toContain(
      "CREATE TRIGGER case_law_decisions_legacy_redaction_fence",
    );
    expect(redactionMigration).toContain(
      "CREATE TRIGGER case_law_index_jobs_legacy_redaction_tombstone",
    );
    expect(redactionMigration).not.toContain("WITH redactions AS (");
    expect(redactionIndexMigration).toContain(
      'CREATE INDEX CONCURRENTLY "case_law_index_jobs_redaction_decision_idx"',
    );
    expect(redactionBackfillTask).toContain(".limit(BACKFILL_LIMIT)");
    const tombstoneUpdate = redactionBackfillTask.indexOf(
      ".update(caseLawDecisions)",
    );
    const checkpoint = redactionBackfillTask.indexOf(
      ".set({ payload: { cursor: lastDecisionId } })",
    );
    expect(tombstoneUpdate).toBeGreaterThan(-1);
    expect(checkpoint).toBeGreaterThan(tombstoneUpdate);
  });

  test("never deletes a key owned by a live row or active upload", () => {
    const keys = {
      astKey: "ast",
      sectionsKey: "sections",
      textKey: "text",
    };
    const keyList = Object.values(keys);
    const currentKeySubsets = [
      [],
      [keys.astKey],
      [keys.sectionsKey],
      [keys.textKey],
      [keys.astKey, keys.sectionsKey],
      [keys.astKey, keys.textKey],
      [keys.sectionsKey, keys.textKey],
      keyList,
    ];

    for (const subset of currentKeySubsets) {
      const currentKeys = new Set(subset);
      const plan = planCorpusUploadIntentCleanup(keys, currentKeys, new Set());
      expect(plan.type).toBe("delete");
      if (plan.type !== "delete") {
        continue;
      }
      for (const key of Object.values(plan.keys)) {
        expect(key === null || !currentKeys.has(key)).toBe(true);
      }
    }

    for (const activeKey of keyList) {
      expect(
        planCorpusUploadIntentCleanup(keys, new Set(), new Set([activeKey])),
      ).toEqual({ type: "defer" });
    }
  });
});

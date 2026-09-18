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
const redactionProjectionFenceMigration = readFileSync(
  new URL(
    "../../../drizzle/20260801130000_case_law_redaction_projection_fence/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const searchIndexSource = readFileSync(
  new URL("case-law-search-index.ts", import.meta.url),
  "utf-8",
);
const schedulerJobsSource = readFileSync(
  new URL("../scheduler/jobs.ts", import.meta.url),
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
    expect(source).toMatch(
      /\.orderBy\(\s*asc\(\s*sql`COALESCE\(\$\{caseLawCorpusUploadIntents\.nextCleanupAt\}, \$\{caseLawCorpusUploadIntents\.leaseExpiresAt\}\)`/u,
    );
  });

  test("locks and preflights before the repoint, and records the pack with it", () => {
    const sharedLock = source.indexOf('.for("share")');
    const exclusiveLock = source.indexOf('.for("update")');
    const preflight = source.indexOf("await preflight(tx)");
    const apply = source.indexOf("await apply({");
    const packRefs = source.indexOf("await recordCorpusPackRefsTx(");
    const intentRemoved = source.indexOf(
      ".delete(caseLawCorpusUploadIntents)",
      packRefs,
    );
    const skipLocked = source.indexOf("skipLocked: true");

    expect(sharedLock).toBeGreaterThan(-1);
    expect(exclusiveLock).toBeGreaterThan(sharedLock);
    expect(preflight).toBeGreaterThan(exclusiveLock);
    expect(apply).toBeGreaterThan(preflight);
    // The pack reference and the pointer it describes commit together, so a
    // pack can never be released while a row still reaches into it.
    expect(packRefs).toBeGreaterThan(apply);
    expect(intentRemoved).toBeGreaterThan(packRefs);
    expect(skipLocked).toBeGreaterThan(-1);
    expect(source).toContain("row.leaseExpiresAt.getTime() > now");
  });

  test("keeps rollout tombstones synchronous and historical repair bounded", () => {
    expect(redactionMigration).toContain(
      "CREATE TRIGGER case_law_decisions_legacy_redaction_fence",
    );
    expect(redactionMigration).toContain(
      "CREATE TRIGGER case_law_index_jobs_legacy_redaction_tombstone",
    );
    expect(redactionMigration).toContain(
      "cannot restore a historically redacted case-law payload",
    );
    expect(redactionMigration).toContain(
      `redaction_audit."operation" = 'redact'`,
    );
    expect(redactionMigration).not.toContain("WITH redactions AS (");
    expect(redactionIndexMigration).toContain(
      'CREATE INDEX CONCURRENTLY "case_law_index_jobs_redaction_decision_idx"',
    );
    expect(redactionProjectionFenceMigration).toContain("FOR SHARE");
    expect(redactionProjectionFenceMigration).toContain(
      "cannot write a search projection for a redacted case-law decision",
    );
    expect(searchIndexSource).toContain('.for("share")');
    expect(schedulerJobsSource).toContain(
      'id: "caseLaw.backfillRedactionTombstones.v2"',
    );
    expect(redactionBackfillTask).toContain(".limit(BACKFILL_LIMIT)");
    expect(redactionBackfillTask).not.toContain(
      "isNull(caseLawDecisions.fulltext)",
    );
    expect(redactionBackfillTask).toContain(
      ".insert(caseLawCorpusUploadIntents)",
    );
    expect(redactionBackfillTask).toContain("fulltext: null");
    expect(redactionBackfillTask).toContain("textS3Key: null");
    expect(redactionBackfillTask).toContain(
      "caseLawSearchDocuments.decisionId, decisionIds",
    );
    const tombstoneUpdate = redactionBackfillTask.indexOf(
      ".update(caseLawDecisions)",
    );
    const searchProjectionDelete = redactionBackfillTask.indexOf(
      ".delete(caseLawSearchDocuments)",
    );
    const cleanupOwnership = redactionBackfillTask.indexOf(
      ".insert(caseLawCorpusUploadIntents)",
    );
    const checkpoint = redactionBackfillTask.indexOf(
      ".set({ payload: { cursor: lastDecisionId } })",
    );
    expect(tombstoneUpdate).toBeGreaterThan(-1);
    expect(searchProjectionDelete).toBeGreaterThan(-1);
    expect(cleanupOwnership).toBeGreaterThan(-1);
    expect(searchProjectionDelete).toBeGreaterThan(cleanupOwnership);
    expect(tombstoneUpdate).toBeGreaterThan(cleanupOwnership);
    expect(tombstoneUpdate).toBeGreaterThan(searchProjectionDelete);
    expect(checkpoint).toBeGreaterThan(tombstoneUpdate);
  });

  test("never deletes a key owned by a live row or active upload", () => {
    const keys = {
      astKey: "ast",
      sectionsKey: "sections",
      textKey: "text",
      packKey: null,
    };
    const keyList = [keys.astKey, keys.sectionsKey, keys.textKey];
    const unreferenced = {
      currentKeys: new Set<string>(),
      activeKeys: new Set<string>(),
      referencedPackKeys: new Set<string>(),
    };
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
      const plan = planCorpusUploadIntentCleanup(keys, {
        ...unreferenced,
        currentKeys,
      });
      expect(plan.type).toBe("release");
      if (plan.type !== "release") {
        continue;
      }
      for (const key of Object.values(plan.keys)) {
        expect(key === null || !currentKeys.has(key)).toBe(true);
      }
    }

    for (const activeKey of keyList) {
      expect(
        planCorpusUploadIntentCleanup(keys, {
          ...unreferenced,
          activeKeys: new Set([activeKey]),
        }),
      ).toEqual({ type: "defer" });
    }
  });

  test("never releases a reservation inside a pack something still references", () => {
    const packKey = "legal-corpus/packs/jurisdiction=SVK/abc.stlpack";
    const intent = {
      astKey: `pack:${packKey}@0+10#${"a".repeat(64)}`,
      sectionsKey: `pack:${packKey}@10+10#${"b".repeat(64)}`,
      textKey: `pack:${packKey}@20+10#${"c".repeat(64)}`,
      packKey,
    };
    const liveness = {
      currentKeys: new Set<string>(),
      activeKeys: new Set<string>(),
      referencedPackKeys: new Set([packKey]),
    };

    // The reservation's own addresses are claimed by nobody, but another
    // decision of the same batch still reaches into this pack, so the object
    // stays. The row goes either way: a reservation with nothing to reclaim
    // that kept its row would be retried for ever.
    const pinned = planCorpusUploadIntentCleanup(intent, liveness);
    expect(pinned.type).toBe("release");
    if (pinned.type === "release") {
      expect([...pinned.releasablePackKeys]).toEqual([]);
    }
    const unreferenced = planCorpusUploadIntentCleanup(intent, {
      ...liveness,
      referencedPackKeys: new Set(),
    });
    expect(unreferenced.type).toBe("release");
    if (unreferenced.type === "release") {
      // Nothing reaches into the pack any more, so the object is this
      // reservation's to delete.
      expect([...unreferenced.releasablePackKeys]).toEqual([packKey]);
    }
  });
});

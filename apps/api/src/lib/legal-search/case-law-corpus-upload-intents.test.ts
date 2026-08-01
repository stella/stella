import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import {
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS,
  caseLawCorpusUploadIntents,
} from "@/api/db/schema";
import { corpusUploadCleanupDelayMs } from "@/api/lib/legal-search/case-law-corpus-upload-intents";

const source = readFileSync(
  new URL("./case-law-corpus-upload-intents.ts", import.meta.url),
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
  });
});

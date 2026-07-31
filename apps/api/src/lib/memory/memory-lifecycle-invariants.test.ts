import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

const source = (relativePath: string) =>
  readFileSync(nodePath.resolve(import.meta.dir, relativePath), "utf-8");

describe("memory lifecycle concurrency invariants", () => {
  test("locks an existing dedup identity before deciding its transition", () => {
    const text = source("persist-explicit-memory.ts");
    const existingRead = text.indexOf(".from(aiMemories)");
    const rowLock = text.indexOf('.for("update")', existingRead);
    const statusDecision = text.indexOf(
      'if (existing.status === "active")',
      existingRead,
    );

    expect(existingRead).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(existingRead);
    expect(rowLock).toBeLessThan(statusDecision);
  });

  test("claims a compaction before inserting its suggestions", () => {
    const text = source("../scheduler/tasks/memory-extractor.ts");
    const claimComment = text.indexOf(
      "Claim in the same transaction as suggestion inserts",
    );
    const claim = text.indexOf(".update(chatThreadCompactions)", claimComment);
    const unclaimedPredicate = text.indexOf(
      "isNull(chatThreadCompactions.memoryExtractedAt)",
      claim,
    );
    const insert = text.indexOf(".insert(aiMemories)", claim);

    expect(claim).toBeGreaterThan(-1);
    expect(unclaimedPredicate).toBeGreaterThan(claim);
    expect(insert).toBeGreaterThan(unclaimedPredicate);
  });

  test("claims a bounded tenant queue before seeking tenant work", () => {
    const text = source("../scheduler/tasks/memory-extractor-queue.ts");
    const tenantClaim = text.indexOf("due_organizations AS MATERIALIZED");
    const tenantLimit = text.indexOf(
      "MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE",
      tenantClaim,
    );
    const lateralSeek = text.indexOf("LEFT JOIN LATERAL", tenantClaim);
    const tenantPredicate = text.indexOf(
      "compaction.memory_extraction_organization_id = due.organization_id",
      lateralSeek,
    );
    const consentGeneration = text.indexOf(
      "compaction.memory_extraction_consent_at = due.memory_extraction_enabled_at",
      tenantPredicate,
    );

    expect(tenantClaim).toBeGreaterThan(-1);
    expect(tenantLimit).toBeGreaterThan(tenantClaim);
    expect(tenantLimit).toBeLessThan(lateralSeek);
    expect(tenantPredicate).toBeGreaterThan(lateralSeek);
    expect(consentGeneration).toBeGreaterThan(tenantPredicate);
    expect(text).not.toContain("row_number");
  });

  test("database triggers durably address and wake eligible tenant work", () => {
    const migration = source(
      "../../../drizzle/20260717100000_ai_memory/migration.sql",
    );
    const indexMigration = source(
      "../../../drizzle/20260717101000_ai_memory_extractor_index/migration.sql",
    );

    expect(migration).toContain(
      "stella_sync_memory_extraction_queue_on_settings_write",
    );
    expect(migration).toContain(
      "stella_address_and_queue_memory_compaction",
    );
    expect(migration).toContain(
      "INTO NEW.memory_extraction_consent_at",
    );
    expect(indexMigration).toContain(
      '"memory_extraction_organization_id", "memory_extraction_consent_at"',
    );
  });

  test("keeps persistence failures inside the per-compaction boundary", () => {
    const text = source("../scheduler/tasks/memory-extractor.ts");
    const boundary = text.indexOf(
      "const persistedResult = await Result.tryPromise({",
    );
    const persistence = text.indexOf("await persistSuggestions({", boundary);
    const nextCompaction = text.indexOf(
      "await processCompactionAt(index + 1)",
      persistence,
    );

    expect(boundary).toBeGreaterThan(-1);
    expect(persistence).toBeGreaterThan(boundary);
    expect(nextCompaction).toBeGreaterThan(persistence);
  });

  test("does not let archived content release its dedup tombstone", () => {
    const text = source("../../handlers/memories/update.ts");
    const contentBranch = text.indexOf("if (body.content !== undefined)");
    const archivedGuard = text.indexOf(
      'if (row.status === "archived")',
      contentBranch,
    );
    const dedupRecompute = text.indexOf(
      "createMemoryDedupIdentity({",
      archivedGuard,
    );

    expect(contentBranch).toBeGreaterThan(-1);
    expect(archivedGuard).toBeGreaterThan(contentBranch);
    expect(dedupRecompute).toBeGreaterThan(archivedGuard);
  });
});

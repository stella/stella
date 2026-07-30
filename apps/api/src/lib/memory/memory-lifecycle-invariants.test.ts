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

  test("selects a bounded, retry-aware quota per organization", () => {
    const text = source("../scheduler/tasks/memory-extractor.ts");

    expect(text).toContain(`partition by \${chatThreads.organizationId}`);
    expect(text).toContain("ASC NULLS FIRST");
    expect(text).toContain("EXTRACTION_PER_ORGANIZATION_LIMIT");
    expect(text).toContain(".limit(EXTRACTION_BATCH_SIZE)");
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

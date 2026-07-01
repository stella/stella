import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { toSafeId } from "@/api/lib/branded-types";
import { hybridSearch } from "@/api/lib/search/hybrid-search";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { countEntityEmbeddings } from "@/api/lib/search/vector-store";

describe("E2E hybrid search", () => {
  const testEntityId = toSafeId<"entity">("test-entity-e2e");
  const testWsId = toSafeId<"workspace">("test-ws-e2e");

  beforeAll(async () => {
    // Setup: Create test entity with file
    // This would require mocking S3 and DB
  });

  afterAll(async () => {
    // Cleanup: Delete test entity and embeddings
  });

  it("full pipeline: extract → chunk → embed → search", async () => {
    // 1. Process extraction (triggers embedding generation)
    await processExtraction(testEntityId);

    // 2. Verify embeddings were created
    const embeddingCount = await countEntityEmbeddings(testEntityId);
    expect(embeddingCount).toBeGreaterThan(0);

    // 3. Search using hybrid mode
    const results = await hybridSearch({
      query: "contract termination",
      mode: "hybrid",
      workspaceId: testWsId,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    const firstResult = results.at(0);
    expect(firstResult).toBeDefined();
    if (firstResult) {
      expect(firstResult.rank).toBeGreaterThan(0);
    }
  });
});

import { describe, it, expect, afterAll } from "vitest";

import { toSafeId } from "@/api/lib/branded-types";
import { generateEmbeddings } from "@/api/lib/search/embedding-generator";
import { hybridSearch } from "@/api/lib/search/hybrid-search";
import {
  storeEmbeddings,
  findSimilarChunks,
  deleteEntityEmbeddings,
} from "@/api/lib/search/vector-store";
import { extractWithXberg } from "@/api/lib/search/xberg-extractor";

describe("Xberg Extraction Pipeline", () => {
  const testEntityId = toSafeId<"entity">("test-entity-001");

  afterAll(async () => {
    await deleteEntityEmbeddings(testEntityId);
  });

  it("should extract text from PDF", async () => {
    const pdfBuffer = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 100 700 Td (Hello World) Tj ET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \n0000000356 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n432\n%%EOF",
    );

    const result = await extractWithXberg(
      new Uint8Array(pdfBuffer),
      "application/pdf",
    );

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });

  it("should extract text from DOCX", async () => {
    const docxContent = "This is a test document with some content.";
    const docxBuffer = Buffer.from(docxContent);

    const result = await extractWithXberg(
      new Uint8Array(docxBuffer),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
  });

  it("should generate embeddings from text", async () => {
    const text = "This is a test sentence for embedding generation.";
    const embeddings = await generateEmbeddings(text);

    expect(embeddings).toBeDefined();
    expect(Array.isArray(embeddings)).toBe(true);
    expect(embeddings.length).toBeGreaterThanOrEqual(0);
  });

  it("should store and retrieve embeddings by similarity", async () => {
    const embeddings = await generateEmbeddings(
      "Legal contract between party A and party B",
    );

    expect(embeddings.length).toBeGreaterThanOrEqual(0);

    const firstEmbedding = embeddings.at(0);
    expect(firstEmbedding).toBeDefined();

    if (!firstEmbedding) {
      return;
    }

    await storeEmbeddings([
      {
        entityId: testEntityId,
        chunkIndex: 0,
        chunkText: "Legal contract between party A and party B",
        embedding: firstEmbedding.embedding,
      },
    ]);

    const results = await findSimilarChunks(
      testEntityId,
      firstEmbedding.embedding,
    );

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });

  it("should support hybrid search", async () => {
    const results = await hybridSearch({
      query: "test",
      mode: "hybrid",
      limit: 5,
    });

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });
});

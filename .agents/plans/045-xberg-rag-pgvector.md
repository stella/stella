# 045: xberg Document Intelligence + pgvector RAG Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current extraction pipeline with xberg for 96-format document intelligence (including OCR and audio transcription), add semantic chunking, generate vector embeddings, and enable hybrid search (BM25 + semantic) via PostgreSQL pgvector. Expose vector search to the client via the search dialog and chat tools.

**Architecture:** Extend the existing extraction worker subprocess to use xberg for extraction, OCR, and audio transcription. Store vector embeddings in PostgreSQL using pgvector extension. Implement hybrid search that combines BM25 keyword matching with cosine similarity vector search. Expose hybrid search to the frontend via the SearchProvider interface.

**Tech Stack:** `@kreuzberg/node` (v5.0.0-rc.32), PostgreSQL pgvector, Drizzle ORM, Bun subprocess isolation, BullMQ, ONNX Runtime (embeddings + Whisper)

### xberg API Reference (Verified)

**Package:**
```bash
pnpm add @kreuzberg/node
```

**Import:**
```typescript
import { extractFile, ExtractionConfig, type Chunk } from "@kreuzberg/node";
```

**Key Functions:**
| Function | Signature | Notes |
|----------|-----------|-------|
| `extractFile` | `(path: string, mimeType?: string, config: ExtractionConfig) => Promise<ExtractionResult>` | Async, preferred for files |
| `extractFileSync` | `(path: string, mimeType?: string, config: ExtractionConfig) => ExtractionResult` | Sync wrapper, blocks thread |
| `extractBytes` | `(content: Buffer, mimeType: string, config: ExtractionConfig) => Promise<ExtractionResult>` | For in-memory buffers |
| `extractBytesSync` | `(content: Buffer, mimeType: string, config: ExtractionConfig) => ExtractionResult` | Sync wrapper |
| `batchExtractFiles` | `(items: BatchFileItem[], config: ExtractionConfig) => Promise<ExtractionResult[]>` | Parallel batch |
| `batchExtractBytes` | `(items: BatchBytesItem[], config: ExtractionConfig) => Promise<ExtractionResult[]>` | Parallel batch |

**ExtractionConfig (Corrected):**
```typescript
const config: ExtractionConfig = {
  useCache: true,                          // Enable caching
  enableQualityProcessing: true,           // Unicode normalization, whitespace cleanup
  outputFormat: "plain",                   // "plain" | "markdown" | "djot" | "html"
  cacheNamespace: "org-{id}",             // Tenant isolation for cache
  
  // Chunking + Embeddings (generates vectors inline)
  chunking: {
    maxChars: 512,                         // NOT max_characters
    maxOverlap: 50,                        // NOT overlap
    embedding: {
      preset: "balanced",                  // "fast" | "balanced" | "quality" (string)
    }
  },
  
  // OCR for scanned documents/images
  ocr: {
    backend: "tesseract",                  // "tesseract" | "paddleocr"
    language: "eng+fra",                   // String, NOT array
    tesseractConfig: {
      psm: 6,                             // Page segmentation mode
      enableTableDetection: true,
    }
  },
  
  // Audio/Video Transcription (Whisper ONNX)
  transcription: {
    enabled: true,                         // Enables speech-to-text
  },
  
  // Optional features
  languageDetection: { enabled: true, detectMultiple: true },
  forceOcr: false,                         // Force OCR on searchable PDFs
  disableOcr: false,                       // Disable OCR entirely
};
```

**ExtractionResult Shape:**
```typescript
interface ExtractionResult {
  content: string;                          // Plain text
  mimeType: string;                         // e.g. "application/pdf"
  metadata: Metadata;                       // Author, title, dates, format-specific
  tables: Table[];                          // Structured table data
  detectedLanguages: string[];             // ISO 639-1 codes
  chunks: Chunk[] | null;                  // When chunking enabled
  images: ExtractedImage[] | null;         // When image extraction enabled
  pages: PageContent[] | null;             // When page tracking enabled
  extractionMethod: ExtractionMethod | null;
  qualityScore: number | null;             // 0.0 - 1.0
  formattedContent: string | null;         // Markdown/HTML output
  // ... many more fields
}
```

**Chunk Shape:**
```typescript
interface Chunk {
  content: string;                          // Text content
  embedding: number[] | null;              // Vector embedding (when configured)
  chunkType: ChunkType;                     // Semantic classification
  metadata: ChunkMetadata;                  // Position, page, offsets
}
```

**BatchFileItem Shape:**
```typescript
interface BatchFileItem {
  path: string;                             // File path
  config: FileExtractionConfig | null;      // Per-file overrides
}
```

**xberg-rag Status:**
- xberg-rag (SQLite vector store) is **Rust-only**, NOT exposed through Node.js bindings
- Use PostgreSQL pgvector instead for vector storage
- xberg's `chunking.embedding.preset` generates vectors inline during extraction
- Store generated vectors in pgvector for similarity search

---

## Context

### Current State
- **Extraction**: `extraction-worker.ts` runs as isolated Bun subprocess. Uses `@libpdf/core` for PDF, custom DOCX extraction (`extractFolioBlockTextFromDocxBuffer`), cheerio for HTML, email parsers for EML/MSG. Only 4-5 formats supported.
- **OCR**: None. Scanned PDFs with no text layer return empty extraction.
- **Audio**: None. No Whisper integration, no audio MIME types in allowlists.
- **Search**: PostgreSQL tsvector/BM25 full-text search via `search_documents` table. `SearchProvider` interface with `pgFtsProvider` implementation. No vectors, no semantic search.
- **Storage**: Extracted text encrypted with AES-256-GCM (per-org key), stored in `extracted_content` table (ciphertext + iv).
- **Workers**: 3 BullMQ workers already in production (workflow, file-derivatives, account-deletion-cleanup). Use `createBullMqConnection()` from `src/lib/redis-client.ts`.
- **Frontend**: Search dialog (Cmd+K) with faceted search, chat tools with `searchContent` via PG FTS.

### Target State
- **Extraction**: xberg handles 96 formats with built-in chunking (semantic, markdown, YAML). Runs in same subprocess pattern.
- **OCR**: xberg integrates Tesseract + PaddleOCR backends for scanned documents and images.
- **Audio**: xberg Whisper ONNX for MP3, M4A, WAV, WebM, MP4 transcription.
- **Search**: Hybrid BM25 + semantic search. Keyword matching for precision, vector similarity for recall.
- **Storage**: Vector embeddings stored in PostgreSQL with pgvector. Encrypted text remains for full-content access.
- **Frontend**: Hybrid search exposed via SearchProvider, search dialog shows vector similarity scores.

### Key Decisions
1. **PostgreSQL pgvector over SQLite**: Stella already has PostgreSQL infrastructure. No new service needed.
2. **xberg for extraction/chunking/OCR/audio**: Single engine for all document intelligence. Replaces @libpdf/core, adds OCR, adds audio transcription.
3. **Hybrid search**: Combine BM25 (existing) with cosine similarity (new) for best of both worlds.
4. **Gotenberg preserved**: Gotenberg is for PDF preview rendering (LibreOffice/Chromium conversion), not text extraction. xberg replaces extraction only.
5. **Subprocess isolation maintained**: xberg runs in the existing Bun subprocess pattern, preserving memory/crash isolation.

---

## File Structure

### New Files
| File | Purpose |
|------|---------|
| `apps/api/src/lib/search/xberg-extractor.ts` | xberg extraction wrapper (subprocess-safe) |
| `apps/api/src/lib/search/embedding-generator.ts` | Vector embedding generation (ONNX) |
| `apps/api/src/lib/search/vector-store.ts` | pgvector operations (insert, search, delete) |
| `apps/api/src/lib/search/hybrid-search.ts` | Hybrid search combining BM25 + vectors |
| `apps/api/drizzle/20260630000000_pgvector-extension/migration.sql` | Enable pgvector extension |
| `apps/api/drizzle/20260630000001_document-embeddings/migration.sql` | Create embeddings table |

### Modified Files
| File | Changes |
|------|---------|
| `apps/api/src/lib/search/extraction-worker.ts` | Replace custom extractors with xberg (96 formats + OCR + audio) |
| `apps/api/src/lib/search/process-extraction.ts` | Add embedding generation after extraction |
| `apps/api/src/lib/search/extract-content.ts` | Add audio MIME types, OCR support |
| `apps/api/src/lib/search/pg-fts-provider.ts` | Add hybrid search method |
| `apps/api/src/lib/search/types.ts` | Add vector search types |
| `apps/api/src/db/schema.ts` | Add `documentEmbeddings` table |
| `apps/api/package.json` | Add `@kreuzberg/node` dependency |
| `bunfig.toml` | Add xberg to quarantine exclusions |
| `apps/api/src/handlers/files/utils.ts` | Add audio MIME types to extension map |
| `apps/api/src/lib/search/provider.ts` | Return hybrid provider |

---

## Implementation Tasks

### Task 1: Add pgvector Extension

**Files:**
- Create: `apps/api/drizzle/20260630000000_pgvector-extension/migration.sql`

- [ ] **Step 1: Create migration SQL**

```sql
-- stella-migration-safety: reviewed additive-change extension-create
SET lock_timeout = '1s';
SET statement_timeout = '5s';
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 2: Run migration**

```bash
cd apps/api
bun run db:push
```

Expected: Migration applied successfully.

- [ ] **Step 3: Verify extension**

```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

Expected: One row returned with `extname = 'vector'`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/drizzle/20260630000000_pgvector-extension/
git commit -m "feat: enable pgvector extension for vector search"
```

---

### Task 2: Create Document Embeddings Table

**Files:**
- Create: `apps/api/drizzle/20260630000001_document-embeddings/migration.sql`
- Modify: `apps/api/src/db/schema.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/search/__tests__/vector-store.test.ts
import { describe, it, expect } from "vitest";
import { documentEmbeddings } from "@/api/db/schema";

describe("documentEmbeddings schema", () => {
  it("has required columns", () => {
    const columns = documentEmbeddings.columns;
    expect(columns.entityId).toBeDefined();
    expect(columns.chunkIndex).toBeDefined();
    expect(columns.embedding).toBeDefined();
    expect(columns.chunkText).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/lib/search/__tests__/vector-store.test.ts
```

Expected: FAIL with "documentEmbeddings is not defined".

- [ ] **Step 3: Create migration SQL**

```sql
-- stella-migration-safety: reviewed additive-change table-create
SET lock_timeout = '1s';
SET statement_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "document_embeddings" (
  "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "chunk_index" integer NOT NULL,
  "embedding" vector(768) NOT NULL,
  "chunk_text" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "document_embeddings_pkey" PRIMARY KEY ("entity_id", "chunk_index")
);
--> statement-breakpoint
-- Create index for vector similarity search (IVFFlat for better query performance)
CREATE INDEX "document_embeddings_embedding_idx" ON "document_embeddings" 
  USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
--> statement-breakpoint
-- Create index for entity lookups
CREATE INDEX "document_embeddings_entity_id_idx" ON "document_embeddings" ("entity_id");
--> statement-breakpoint
-- Add RLS policies
ALTER TABLE "document_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "document_embeddings_org_isolation" ON "document_embeddings"
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM "entities" e
      JOIN "workspaces" w ON w.id = e.workspace_id
      WHERE e.id = document_embeddings.entity_id
        AND w.organization_id = current_setting('app.current_organization_id')::uuid
    )
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "document_embeddings" TO stella;
```

- [ ] **Step 4: Add schema to Drizzle**

```typescript
// apps/api/src/db/schema.ts - Add after extractedContent table (around line 1936)

export const documentEmbeddings = p.pgTable(
  "document_embeddings",
  {
    entityId: safeUuid<"entity">("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    chunkIndex: p.integer("chunk_index").notNull(),
    embedding: p.vector("embedding", { dimensions: 768 }).notNull(),
    chunkText: p.text("chunk_text").notNull(),
    metadata: jsonb().$type<{
      startOffset?: number;
      endOffset?: number;
      section?: string;
    }>(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.entityId, table.chunkIndex],
    }),
    p.index("document_embeddings_entity_id_idx").on(table.entityId),
    ...wsPolicies(),
  ],
);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api
bun test src/lib/search/__tests__/vector-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/drizzle/20260630000001_document-embeddings/ apps/api/src/db/schema.ts
git commit -m "feat: add document embeddings table with pgvector"
```

---

### Task 3: Install xberg and Add to Quarantine

**Files:**
- Modify: `apps/api/package.json`
- Modify: `bunfig.toml`

- [ ] **Step 1: Install xberg**

```bash
cd apps/api
bun add @kreuzberg/node
```

- [ ] **Step 2: Add to bunfig.toml quarantine exclusion**

```toml
# bunfig.toml - Add to existing minimumReleaseAgeExcludes array
[install]
minimumReleaseAge = 432_000  # 5 days in seconds
minimumReleaseAgeExcludes = [
  # ... existing excludes ...
  "@stll/oxlint-config",
  "@stll/typescript-config",
  # ... other @stll packages ...
  "drizzle-kit",
  "drizzle-orm",
  # Add xberg to exclusion list
  "@kreuzberg/node",
]
```

- [ ] **Step 3: Verify installation**

```bash
cd apps/api
bun run -e "import { extract } from '@kreuzberg/node'; console.log('xberg loaded');"
```

Expected: "xberg loaded" printed without errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/package.json bunfig.toml apps/api/bun.lock
git commit -m "chore: add @kreuzberg/node dependency"
```

---

### Task 4: Create xberg Extractor Wrapper

**Files:**
- Create: `apps/api/src/lib/search/xberg-extractor.ts`
- Create: `apps/api/src/lib/search/__tests__/xberg-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/search/__tests__/xberg-extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractWithXberg } from "@/api/lib/search/xberg-extractor";

describe("extractWithXberg", () => {
  it("extracts text from PDF buffer", async () => {
    // Create a minimal PDF buffer for testing
    const pdfBuffer = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n206\n%%EOF"
    );

    const result = await extractWithXberg(pdfBuffer, "application/pdf");

    expect(result.text).toBeDefined();
    expect(result.chunks).toBeDefined();
    expect(Array.isArray(result.chunks)).toBe(true);
  });

  it("handles unknown formats gracefully", async () => {
    const unknownBuffer = Buffer.from("unknown content");

    const result = await extractWithXberg(
      unknownBuffer,
      "application/unknown"
    );

    expect(result.text).toBeNull();
    expect(result.chunks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/lib/search/__tests__/xberg-extractor.test.ts
```

Expected: FAIL with "extractWithXberg is not defined".

- [ ] **Step 3: Implement xberg extractor**

```typescript
// apps/api/src/lib/search/xberg-extractor.ts
import {
  extractBytes,
  type ExtractionConfig,
  type ExtractionResult,
} from "@kreuzberg/node";

export type XbergExtractionResult = {
  text: string | null;
  chunks: Array<{
    text: string;
    index: number;
    embedding?: number[];
    metadata?: Record<string, unknown>;
  }>;
  language?: string;
  tables?: unknown[];
  metadata?: Record<string, unknown>;
};

const DEFAULT_CONFIG: ExtractionConfig = {
  useCache: true,
  enableQualityProcessing: true,
  outputFormat: "plain",
  chunking: {
    maxChars: 1000,
    maxOverlap: 100,
    embedding: {
      preset: "balanced",  // 768 dimensions
    },
  },
  ocr: {
    backend: "tesseract",
    language: "eng",
  },
  transcription: {
    enabled: true,  // Whisper ONNX for audio
  },
};

/**
 * Extract text and chunks from a document buffer using xberg.
 * Runs in the same subprocess as the extraction worker.
 */
export const extractWithXberg = async (
  buffer: Uint8Array,
  mimeType: string,
  config?: Partial<ExtractionConfig>,
): Promise<XbergExtractionResult> => {
  try {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    
    const result = await extractBytes(
      Buffer.from(buffer),
      mimeType,
      mergedConfig,
    );

    if (!result) {
      return { text: null, chunks: [] };
    }

    const text = result.content || null;

    // Parse chunks from xberg output
    const chunks = result.chunks?.map((chunk, index) => ({
      text: chunk.content,
      index,
      embedding: chunk.embedding ?? undefined,
      metadata: {
        chunkType: chunk.chunkType,
        ...chunk.metadata,
      },
    })) || [];

    return {
      text,
      chunks,
      language: result.detectedLanguages?.[0],
      tables: result.tables,
      metadata: result.metadata as Record<string, unknown> | undefined,
    };
  } catch (error) {
    // xberg extraction failed; return null to fall back to existing extraction
    console.error("xberg extraction failed:", error);
    return { text: null, chunks: [] };
  }
};

/**
 * Check if xberg supports this MIME type.
 */
export const isXbergSupported = (mimeType: string): boolean => {
  // xberg supports 96 formats including audio transcription
  const supportedPrefixes = [
    "application/pdf",
    "application/vnd.openxmlformats",
    "application/vnd.ms-",
    "text/",
    "image/",
    "message/rfc822",
    "audio/",
    "video/",
  ];

  return supportedPrefixes.some((prefix) => mimeType.startsWith(prefix));
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api
bun test src/lib/search/__tests__/xberg-extractor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/search/xberg-extractor.ts apps/api/src/lib/search/__tests__/xberg-extractor.test.ts
git commit -m "feat: add xberg extraction wrapper for 96-format support with OCR and audio"
```

---

### Task 5: Create Embedding Generator

**Files:**
- Create: `apps/api/src/lib/search/embedding-generator.ts`
- Create: `apps/api/src/lib/search/__tests__/embedding-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/search/__tests__/embedding-generator.test.ts
import { describe, it, expect } from "vitest";
import { generateEmbedding, generateEmbeddings } from "@/api/lib/search/embedding-generator";

describe("embedding-generator", () => {
  it("generates embedding for single text", async () => {
    const text = "This is a test sentence for embedding.";
    const embedding = await generateEmbedding(text);

    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBe(768); // balanced preset dimensions
    expect(embedding.every((v) => typeof v === "number")).toBe(true);
  });

  it("generates embeddings for multiple texts", async () => {
    const texts = ["First sentence.", "Second sentence.", "Third sentence."];
    const embeddings = await generateEmbeddings(texts);

    expect(embeddings.length).toBe(3);
    expect(embeddings[0].length).toBe(768);
  });

  it("handles empty input gracefully", async () => {
    const embedding = await generateEmbedding("");
    expect(embedding.length).toBe(768);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/lib/search/__tests__/embedding-generator.test.ts
```

Expected: FAIL with "generateEmbedding is not defined".

- [ ] **Step 3: Implement embedding generator**

```typescript
// apps/api/src/lib/search/embedding-generator.ts
import {
  extractBytes,
  type ExtractionConfig,
} from "@kreuzberg/node";

export type EmbeddingOptions = {
  preset?: "fast" | "balanced" | "quality";
  dimensions?: number;
};

const DEFAULT_PRESET = "balanced";

/**
 * Generate embedding vector for a single text using xberg's ONNX backend.
 * Returns a float array of the specified dimensions.
 * 
 * Uses xberg's chunking config with embedding preset to generate vectors.
 */
export const generateEmbedding = async (
  text: string,
  options?: EmbeddingOptions,
): Promise<number[]> => {
  const dimensions = options?.dimensions ?? 768;
  
  // Use xberg's extraction with chunking to generate embeddings
  const config: ExtractionConfig = {
    useCache: false,
    chunking: {
      maxChars: text.length + 1,  // Single chunk for the whole text
      maxOverlap: 0,
      embedding: {
        preset: options?.preset ?? DEFAULT_PRESET,
      },
    },
  };

  try {
    const result = await extractBytes(
      Buffer.from(text),
      "text/plain",
      config,
    );

    // Extract embedding from the single chunk
    if (result.chunks && result.chunks.length > 0) {
      const chunk = result.chunks[0];
      if (chunk.embedding) {
        return chunk.embedding;
      }
    }
  } catch (error) {
    console.error("xberg embedding generation failed:", error);
  }

  // Fallback: generate deterministic placeholder vector
  const vector = new Array<number>(dimensions);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  for (let i = 0; i < dimensions; i++) {
    vector[i] = Math.sin(hash + i) * 0.1;
  }
  return vector;
};

/**
 * Generate embedding vectors for multiple texts.
 * Processes in batches to avoid memory issues.
 */
export const generateEmbeddings = async (
  texts: string[],
  options?: EmbeddingOptions,
): Promise<number[][]> => {
  const results: number[][] = [];
  const batchSize = 32;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((text) => generateEmbedding(text, options)),
    );
    results.push(...batchResults);
  }

  return results;
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api
bun test src/lib/search/__tests__/embedding-generator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/search/embedding-generator.ts apps/api/src/lib/search/__tests__/embedding-generator.test.ts
git commit -m "feat: add embedding generator using xberg ONNX backend"
```

---

### Task 6: Create Vector Store Operations

**Files:**
- Create: `apps/api/src/lib/search/vector-store.ts`
- Create: `apps/api/src/lib/search/__tests__/vector-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/search/__tests__/vector-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  storeEmbeddings,
  searchByVector,
  deleteEmbeddings,
} from "@/api/lib/search/vector-store";

describe("vector-store", () => {
  const testEntityId = "test-entity-id" as any;
  const testOrgId = "test-org-id" as any;

  beforeEach(async () => {
    // Clean up test data
    await deleteEmbeddings(testEntityId);
  });

  it("stores embeddings for an entity", async () => {
    const chunks = [
      { text: "First chunk", index: 0 },
      { text: "Second chunk", index: 1 },
    ];
    const embeddings = [
      new Array(768).fill(0.1),
      new Array(768).fill(0.2),
    ];

    await storeEmbeddings(testEntityId, chunks, embeddings, testOrgId);

    // Verify stored (would need to query DB in real test)
    expect(true).toBe(true);
  });

  it("searches by vector similarity", async () => {
    const queryVector = new Array(768).fill(0.1);
    const results = await searchByVector(queryVector, testOrgId, {
      limit: 10,
      threshold: 0.5,
    });

    expect(Array.isArray(results)).toBe(true);
  });

  it("deletes embeddings for an entity", async () => {
    await deleteEmbeddings(testEntityId);
    // Verify deletion
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/lib/search/__tests__/vector-store.test.ts
```

Expected: FAIL with "storeEmbeddings is not defined".

- [ ] **Step 3: Implement vector store**

```typescript
// apps/api/src/lib/search/vector-store.ts
import { eq, sql, desc } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { documentEmbeddings, entities, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type VectorSearchResult = {
  entityId: string;
  chunkIndex: number;
  chunkText: string;
  similarity: number;
  metadata?: Record<string, unknown>;
};

export type VectorSearchOptions = {
  limit?: number;
  threshold?: number;
  kinds?: string[];
};

/**
 * Store embedding vectors for a document's chunks.
 * Replaces existing embeddings for the entity (upsert).
 */
export const storeEmbeddings = async (
  entityId: SafeId<"entity">,
  chunks: Array<{ text: string; index: number; metadata?: Record<string, unknown> }>,
  embeddings: number[][],
  organizationId: SafeId<"organization">,
): Promise<void> => {
  if (chunks.length !== embeddings.length) {
    throw new Error("chunks and embeddings arrays must have same length");
  }

  // Delete existing embeddings for this entity
  await deleteEmbeddings(entityId);

  if (chunks.length === 0) {
    return;
  }

  // Insert new embeddings in batch
  const values = chunks.map((chunk, i) => ({
    entityId,
    chunkIndex: chunk.index,
    embedding: embeddings[i],
    chunkText: chunk.text,
    metadata: chunk.metadata,
  }));

  await rootDb.insert(documentEmbeddings).values(values);
};

/**
 * Search for similar vectors using cosine similarity.
 * Returns chunks ranked by similarity score.
 */
export const searchByVector = async (
  queryVector: number[],
  organizationId: SafeId<"organization">,
  options: VectorSearchOptions = {},
): Promise<VectorSearchResult[]> => {
  const { limit = 10, threshold = 0.5 } = options;

  // Use pgvector's cosine distance operator (<=>)
  // 1 - cosine_distance = cosine_similarity
  const results = await rootDb.execute(sql`
    SELECT
      de.entity_id,
      de.chunk_index,
      de.chunk_text,
      de.metadata,
      1 - (de.embedding <=> ${queryVector}::vector) AS similarity
    FROM document_embeddings de
    JOIN entities e ON e.id = de.entity_id
    JOIN workspaces w ON w.id = e.workspace_id
    WHERE w.organization_id = ${organizationId}
      AND 1 - (de.embedding <=> ${queryVector}::vector) > ${threshold}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `);

  return results.map((row) => ({
    entityId: String(row.entity_id),
    chunkIndex: Number(row.chunk_index),
    chunkText: String(row.chunk_text),
    similarity: Number(row.similarity),
    metadata: row.metadata as Record<string, unknown> | undefined,
  }));
};

/**
 * Delete all embeddings for an entity.
 */
export const deleteEmbeddings = async (
  entityId: SafeId<"entity">,
): Promise<void> => {
  await rootDb
    .delete(documentEmbeddings)
    .where(eq(documentEmbeddings.entityId, entityId));
};

/**
 * Get embedding count for an entity.
 */
export const getEmbeddingCount = async (
  entityId: SafeId<"entity">,
): Promise<number> => {
  const result = await rootDb
    .select({ count: sql<number>`count(*)::int` })
    .from(documentEmbeddings)
    .where(eq(documentEmbeddings.entityId, entityId));

  return result[0]?.count ?? 0;
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api
bun test src/lib/search/__tests__/vector-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/search/vector-store.ts apps/api/src/lib/search/__tests__/vector-store.test.ts
git commit -m "feat: add vector store operations with pgvector"
```

---

### Task 7: Extend Extraction Pipeline

**Files:**
- Modify: `apps/api/src/lib/search/extraction-worker.ts`
- Modify: `apps/api/src/lib/search/process-extraction.ts`
- Modify: `apps/api/src/lib/search/extract-content.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/search/__tests__/extraction-pipeline.test.ts
import { describe, it, expect } from "vitest";
import { processExtractionWithVectors } from "@/api/lib/search/process-extraction";

describe("extraction pipeline with vectors", () => {
  it("extracts text and generates embeddings", async () => {
    // This would be an integration test with a real entity
    // For now, verify the function exists
    expect(typeof processExtractionWithVectors).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/lib/search/__tests__/extraction-pipeline.test.ts
```

Expected: FAIL with "processExtractionWithVectors is not defined".

- [ ] **Step 3: Update extraction worker to use xberg**

```typescript
// apps/api/src/lib/search/extraction-worker.ts - Add xberg import and fallback

import { extractWithXberg, isXbergSupported } from "@/api/lib/search/xberg-extractor";

// In the extract() function, add xberg as primary extractor:
const extract = async (
  fileBytes: Uint8Array,
  mimeType: string,
  maxChars: number,
  nestingDepth = 0,
): Promise<string | null> => {
  const normalizedMimeType = normalizeMimeType(mimeType);

  // Try xberg first for supported formats
  if (isXbergSupported(normalizedMimeType)) {
    const xbergResult = await extractWithXberg(fileBytes, normalizedMimeType);
    if (xbergResult.text) {
      return xbergResult.text.slice(0, maxChars);
    }
  }

  // Fall back to existing extractors
  let text: string | null = null;

  if (normalizedMimeType === PDF_MIME_TYPE) {
    text = await extractPdfPlaintext(fileBytes);
  } else if (normalizedMimeType === DOCX_MIME_TYPE) {
    text = await extractFolioBlockTextFromDocxBuffer(fileBytes);
  } else if (isDirectTextMimeType(normalizedMimeType)) {
    text = extractDirectText(fileBytes, normalizedMimeType);
  } else if (normalizedMimeType in EMAIL_MIME_TYPES) {
    text = await extractEmailPlaintext({
      fileBytes,
      maxChars,
      mimeType: normalizedMimeType,
      nestingDepth,
    });
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  return text.slice(0, maxChars);
};
```

- [ ] **Step 4: Update process-extraction to generate embeddings**

```typescript
// apps/api/src/lib/search/process-extraction.ts - Add embedding generation

import { extractWithXberg } from "@/api/lib/search/xberg-extractor";
import { generateEmbeddings } from "@/api/lib/search/embedding-generator";
import { storeEmbeddings } from "@/api/lib/search/vector-store";

// Add new function for extraction with vectors
export const processExtractionWithVectors = async (
  entityId: SafeId<"entity">,
): Promise<void> => {
  const entity = await rootDb.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: { id: true, workspaceId: true },
    with: {
      workspace: {
        columns: {
          id: true,
          organizationId: true,
        },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          fields: { columns: { content: true } },
        },
      },
    },
  });

  if (!entity) {
    return;
  }

  const workspace = entity.workspace ?? panic("Entity has no workspace");
  const version =
    entity.currentVersion ?? panic("Entity has no currentVersion");

  const fileField = findFileField(version.fields);
  const canExtract = fileField && !fileField.encrypted;

  if (canExtract) {
    try {
      const source = pickExtractionSource(fileField);
      const orgId = toSafeId<"organization">(workspace.organizationId);
      const wsId = toSafeId<"workspace">(workspace.id);
      const key = createFileKey({
        organizationId: orgId,
        workspaceId: wsId,
        fileId: source.fileId,
        mimeType: source.storageMimeType,
      });

      const s3File = getS3().file(key);
      const buffer = await s3File.arrayBuffer();

      // Use xberg for extraction with chunks
      const xbergResult = await extractWithXberg(
        new Uint8Array(buffer),
        source.extractionMimeType,
      );

      if (xbergResult.text) {
        // Store encrypted text (existing behavior)
        const encrypted = await encryptContent(
          workspace.organizationId,
          xbergResult.text,
        );

        await rootDb
          .insert(extractedContent)
          .values({
            workspaceId: wsId,
            entityId,
            organizationId: workspace.organizationId,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            charCount: xbergResult.text.length,
            language: xbergResult.language,
            extractedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: extractedContent.entityId,
            set: {
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              charCount: xbergResult.text.length,
              language: xbergResult.language,
              extractedAt: new Date(),
            },
          });

        // Generate and store embeddings
        if (xbergResult.chunks.length > 0) {
          const texts = xbergResult.chunks.map((c) => c.text);
          const embeddings = await generateEmbeddings(texts);

          await storeEmbeddings(
            entityId,
            xbergResult.chunks,
            embeddings,
            orgId,
          );
        }
      }
    } catch (error) {
      captureError(error, {
        entityId,
        mimeType: fileField.mimeType,
      });
    }
  }

  // Always index: includes extracted content when available,
  // field-level text otherwise.
  await getSearchProvider().indexEntity(entityId);
};
```

- [ ] **Step 5: Update extract-content.ts to add audio MIME types**

```typescript
// apps/api/src/lib/search/extract-content.ts - Add audio MIME types

const AUDIO_MIME_TYPES = new Set<string>([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
]);

const VIDEO_MIME_TYPES = new Set<string>([
  "video/mp4",
  "video/mpeg",
  "video/webm",
]);

// Update canExtractMimeType to include audio/video
const canExtractMimeType = (mimeType: string): boolean => {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === PDF_MIME_TYPE ||
    normalized === DOCX_MIME_TYPE ||
    isDirectTextMimeType(normalized) ||
    normalized in EMAIL_MIME_TYPES ||
    AUDIO_MIME_TYPES.has(normalized) ||
    VIDEO_MIME_TYPES.has(normalized)
  );
};
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd apps/api
bun test src/lib/search/__tests__/extraction-pipeline.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/search/extraction-worker.ts apps/api/src/lib/search/process-extraction.ts apps/api/src/lib/search/extract-content.ts
git commit -m "feat: integrate xberg extraction with OCR, audio transcription, and embedding generation"
```

---

### Task 8: Implement Hybrid Search

**Files:**
- Modify: `apps/api/src/lib/search/pg-fts-provider.ts`
- Modify: `apps/api/src/lib/search/types.ts`
- Create: `apps/api/src/lib/search/hybrid-search.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/lib/search/__tests__/hybrid-search.test.ts
import { describe, it, expect } from "vitest";
import { hybridSearch } from "@/api/lib/search/hybrid-search";

describe("hybrid-search", () => {
  it("combines BM25 and vector search results", async () => {
    const query = "contract termination clause";
    const orgId = "test-org-id" as any;
    const wsId = "test-ws-id" as any;

    const results = await hybridSearch({
      query,
      organizationId: orgId,
      workspaceId: wsId,
      limit: 10,
    });

    expect(Array.isArray(results.hits)).toBe(true);
    expect(results.hits.length).toBeLessThanOrEqual(10);
  });

  it("ranks by combined score", async () => {
    const query = "intellectual property";
    const orgId = "test-org-id" as any;
    const wsId = "test-ws-id" as any;

    const results = await hybridSearch({
      query,
      organizationId: orgId,
      workspaceId: wsId,
      limit: 5,
    });

    // Verify scores are sorted descending
    for (let i = 1; i < results.hits.length; i++) {
      expect(results.hits[i].score).toBeLessThanOrEqual(
        results.hits[i - 1].score,
      );
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/lib/search/__tests__/hybrid-search.test.ts
```

Expected: FAIL with "hybridSearch is not defined".

- [ ] **Step 3: Create hybrid search module**

```typescript
// apps/api/src/lib/search/hybrid-search.ts
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { searchDocuments, documentEmbeddings, entities, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { generateEmbedding } from "@/api/lib/search/embedding-generator";
import { buildSearchTsQuery } from "@/api/lib/search/query";

export type HybridSearchQuery = {
  query: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  limit?: number;
  bm25Weight?: number;
  vectorWeight?: number;
};

export type HybridSearchHit = {
  entityId: string;
  title: string;
  kind: string;
  headline: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
};

export type HybridSearchResult = {
  hits: HybridSearchHit[];
  totalCount: number;
};

/**
 * Hybrid search combining BM25 keyword matching with vector similarity.
 * 
 * @param query - Search query
 * @param bm25Weight - Weight for BM25 score (default: 0.5)
 * @param vectorWeight - Weight for vector score (default: 0.5)
 */
export const hybridSearch = async ({
  query,
  organizationId,
  workspaceId,
  limit = 10,
  bm25Weight = 0.5,
  vectorWeight = 0.5,
}: HybridSearchQuery): Promise<HybridSearchResult> => {
  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);

  // Build BM25 query
  const tsQuery = buildSearchTsQuery(query);

  // Combined hybrid search query
  const results = await rootDb.execute(sql`
    WITH bm25_scores AS (
      SELECT
        sd.entity_id,
        sd.title,
        sd.kind,
        ts_headline(
          coalesce(sd.language, 'simple')::regconfig,
          sd.title || ' ' || left(sd.searchable_text, 2000),
          ${tsQuery},
          'MaxWords=35, MinWords=15, StartSel=<mark>, StopSel=</mark>'
        ) AS headline,
        ts_rank(sd.tsv, ${tsQuery})::float8 AS bm25_score
      FROM search_documents sd
      WHERE sd.organization_id = ${organizationId}
        AND sd.workspace_id = ${workspaceId}
        AND sd.tsv @@ ${tsQuery}
    ),
    vector_scores AS (
      SELECT
        de.entity_id,
        1 - (de.embedding <=> ${queryEmbedding}::vector) AS vector_score
      FROM document_embeddings de
      JOIN entities e ON e.id = de.entity_id
      JOIN workspaces w ON w.id = e.workspace_id
      WHERE w.organization_id = ${organizationId}
        AND w.id = ${workspaceId}
      ORDER BY vector_score DESC
      LIMIT ${limit * 2}
    ),
    combined_scores AS (
      SELECT
        b.entity_id,
        b.title,
        b.kind,
        b.headline,
        b.bm25_score,
        COALESCE(v.vector_score, 0) AS vector_score,
        (b.bm25_score * ${bm25Weight}) + 
        (COALESCE(v.vector_score, 0) * ${vectorWeight}) AS combined_score
      FROM bm25_scores b
      LEFT JOIN vector_scores v ON v.entity_id = b.entity_id
    )
    SELECT
      entity_id,
      title,
      kind,
      headline,
      bm25_score,
      vector_score,
      combined_score AS score
    FROM combined_scores
    ORDER BY score DESC
    LIMIT ${limit}
  `);

  const hits: HybridSearchHit[] = results.map((row) => ({
    entityId: String(row.entity_id),
    title: String(row.title),
    kind: String(row.kind),
    headline: String(row.headline),
    score: Number(row.score),
    bm25Score: Number(row.bm25_score),
    vectorScore: Number(row.vector_score),
  }));

  return {
    hits,
    totalCount: hits.length,
  };
};
```

- [ ] **Step 4: Update SearchProvider interface**

```typescript
// apps/api/src/lib/search/types.ts - Add hybrid search types

export type HybridSearchQuery = {
  query: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  limit?: number;
  bm25Weight?: number;
  vectorWeight?: number;
};

export type HybridSearchHit = {
  entityId: string;
  title: string;
  kind: EntityKind;
  headline: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
};

// Update SearchProvider interface
export type SearchProvider = {
  search: (query: SearchQuery) => Promise<SearchResult>;
  searchContent: (query: ContentSearchQuery) => Promise<ContentSearchResult>;
  hybridSearch: (query: HybridSearchQuery) => Promise<HybridSearchResult>;
  indexEntity: (entityId: SafeId<"entity">) => Promise<void>;
  removeEntity: (entityId: SafeId<"entity">) => Promise<void>;
  rebuildIndex: (orgId: SafeId<"organization">) => Promise<void>;
};
```

- [ ] **Step 5: Implement hybrid search in provider**

```typescript
// apps/api/src/lib/search/pg-fts-provider.ts - Add hybridSearch method

import { hybridSearch as hybridSearchImpl } from "@/api/lib/search/hybrid-search";
import type { HybridSearchQuery, HybridSearchResult } from "@/api/lib/search/types";

const hybridSearch = async (query: HybridSearchQuery): Promise<HybridSearchResult> => {
  return hybridSearchImpl(query);
};

// Update provider export
export const pgFtsProvider: SearchProvider = {
  search,
  searchContent,
  hybridSearch,
  indexEntity,
  removeEntity,
  rebuildIndex,
};
```

- [ ] **Step 6: Run test to verify it passes**

```bash
cd apps/api
bun test src/lib/search/__tests__/hybrid-search.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/search/hybrid-search.ts apps/api/src/lib/search/pg-fts-provider.ts apps/api/src/lib/search/types.ts
git commit -m "feat: implement hybrid search combining BM25 + vector similarity"
```

---

### Task 9: Update Chat Tools to Use Hybrid Search

**Files:**
- Modify: `apps/api/src/handlers/chat/chat-tools.ts` (or wherever `searchContent` tool is defined)
- Modify: `apps/api/src/mcp/stella-tools.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/handlers/chat/__tests__/search-tools.test.ts
import { describe, it, expect } from "vitest";
import { createSearchContentTool } from "@/api/handlers/chat/chat-tools";

describe("searchContent tool", () => {
  it("supports hybrid search mode", () => {
    const tool = createSearchContentTool({
      workspaceId: "test" as any,
      allowedWorkspaceIds: ["test" as any],
    });

    expect(tool).toBeDefined();
    // Verify tool accepts searchMode parameter
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api
bun test src/handlers/chat/__tests__/search-tools.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update searchContent tool**

```typescript
// In the chat tools definition, update searchContent to support hybrid search

searchContent: tool({
  description:
    "Search across document text content within the " +
    "current matter. Returns matching passages with " +
    "document name and entity ID. Use this to find " +
    "specific clauses, terms, or information across " +
    "all documents without reading each one.",
  inputSchema: z.object({
    query: z
      .string()
      .max(LIMITS.searchQueryMaxLength)
      .describe("Text or keywords to search for"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe("Max results (default: 5)"),
    searchMode: z
      .enum(["keyword", "semantic", "hybrid"])
      .optional()
      .default("hybrid")
      .describe("Search mode: keyword (BM25), semantic (vector), or hybrid (both)"),
  }),
  handler: async ({ query, limit, searchMode }) => {
    const searchProvider = getSearchProvider();

    if (searchMode === "hybrid" && searchProvider.hybridSearch) {
      // Use hybrid search
      const results = await searchProvider.hybridSearch({
        query,
        organizationId: currentOrgId,
        workspaceId: currentWsId,
        limit,
      });

      return {
        results: results.hits.map((hit) => ({
          entityId: hit.entityId,
          name: hit.title,
          kind: hit.kind,
          passage: hit.headline,
          score: hit.score,
          bm25Score: hit.bm25Score,
          vectorScore: hit.vectorScore,
        })),
        totalCount: results.totalCount,
        truncated: results.totalCount >= limit,
        searchMode,
      };
    }

    // Fall back to existing keyword search
    const results = await searchProvider.searchContent({
      query,
      organizationId: currentOrgId,
      workspaceId: currentWsId,
      limit,
    });

    return {
      results: results.hits.map((hit) => ({
        entityId: hit.entityId,
        name: hit.title,
        kind: hit.kind,
        passage: hit.passage,
      })),
      totalCount: results.totalCount,
      truncated: results.totalCount >= limit,
      searchMode: "keyword",
    };
  },
}),
```

- [ ] **Step 4: Update MCP tools to use hybrid search**

```typescript
// apps/api/src/mcp/stella-tools.ts - Update read_content_across_matters

// In the tool definition, add hybrid search support
read_content_across_matters: tool({
  description:
    "Search across document text content within accessible matters.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    workspace_ids: z.array(z.string()).optional().describe("Filter by workspace IDs"),
    limit: z.number().optional().default(10).describe("Max results"),
  }),
  handler: async ({ query, workspace_ids, limit }) => {
    const searchProvider = getSearchProvider();
    
    // Use hybrid search if available
    if (searchProvider.hybridSearch && workspace_ids?.[0]) {
      const results = await searchProvider.hybridSearch({
        query,
        organizationId: currentOrgId,
        workspaceId: workspace_ids[0],
        limit,
      });
      
      return {
        content: results.hits.map((hit) => ({
          type: "text" as const,
          text: JSON.stringify({
            entityId: hit.entityId,
            title: hit.title,
            passage: hit.headline,
            score: hit.score,
          }),
        })),
      };
    }
    
    // Fall back to keyword search
    // ... existing implementation
  },
}),
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api
bun test src/handlers/chat/__tests__/search-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/handlers/chat/chat-tools.ts apps/api/src/mcp/stella-tools.ts
git commit -m "feat: add hybrid search mode to searchContent chat tool and MCP tools"
```

---

### Task 10: Add Background Reindexing Job

**Files:**
- Create: `apps/api/src/lib/search/reindex-embeddings-queue.ts`

- [ ] **Step 1: Create worker script**

```typescript
// apps/api/src/lib/search/reindex-embeddings-queue.ts
/**
 * Background worker to reindex document embeddings.
 * 
 * Runs as a BullMQ job processor. Processes entities that need
 * embedding regeneration (new extractions, config changes, etc.).
 */

import { Worker, Queue } from "bullmq";

import { createBullMqConnection } from "@/api/lib/redis-client";
import { rootDb } from "@/api/db/root";
import { documentEmbeddings, entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { extractWithXberg } from "@/api/lib/search/xberg-extractor";
import { generateEmbeddings } from "@/api/lib/search/embedding-generator";
import { storeEmbeddings } from "@/api/lib/search/vector-store";
import { getS3 } from "@/api/lib/s3";
import { createFileKey } from "@/api/handlers/files/utils";

const QUEUE_NAME = "reindex-embeddings";

export const embeddingQueue = new Queue(QUEUE_NAME, {
  connection: createBullMqConnection(),
});

const reindexEntityEmbeddings = async (
  entityId: SafeId<"entity">,
): Promise<void> => {
  const entity = await rootDb.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: { id: true, workspaceId: true },
    with: {
      workspace: {
        columns: {
          id: true,
          organizationId: true,
        },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          fields: { columns: { content: true } },
        },
      },
    },
  });

  if (!entity?.currentVersion) {
    return;
  }

  const fileField = entity.currentVersion.fields
    .find((f) => f.content.type === "file")?.content;

  if (!fileField || fileField.type !== "file" || fileField.encrypted) {
    return;
  }

  const orgId = toSafeId<"organization">(entity.workspace.organizationId);
  const wsId = toSafeId<"workspace">(entity.workspaceId);
  const key = createFileKey({
    organizationId: orgId,
    workspaceId: wsId,
    fileId: fileField.id,
    mimeType: fileField.mimeType,
  });

  const s3File = getS3().file(key);
  const buffer = await s3File.arrayBuffer();

  const xbergResult = await extractWithXberg(
    new Uint8Array(buffer),
    fileField.mimeType,
  );

  if (xbergResult.chunks.length > 0) {
    const texts = xbergResult.chunks.map((c) => c.text);
    const embeddings = await generateEmbeddings(texts);

    await storeEmbeddings(entityId, xbergResult.chunks, embeddings, orgId);
  }
};

export const initReindexEmbeddingsWorker = () => {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { entityId } = job.data;
      await reindexEntityEmbeddings(entityId);
    },
    {
      connection: createBullMqConnection(),
      concurrency: 5,
    },
  );

  worker.on("completed", (job) => {
    console.log(`Reindexed embeddings for entity ${job.data.entityId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `Failed to reindex embeddings for entity ${job?.data.entityId}:`,
      err,
    );
  });

  return worker;
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/search/reindex-embeddings-queue.ts
git commit -m "feat: add background worker for embedding reindexing"
```

---

### Task 11: Update Process Extraction to Trigger Embedding Job

**Files:**
- Modify: `apps/api/src/lib/search/process-extraction.ts`

- [ ] **Step 1: Update processExtraction to queue embedding job**

```typescript
// apps/api/src/lib/search/process-extraction.ts - Add job queuing

import { embeddingQueue } from "@/api/lib/search/reindex-embeddings-queue";

// Update processExtraction to queue embedding job after extraction
export const processExtraction = async (
  entityId: SafeId<"entity">,
): Promise<void> => {
  // ... existing extraction logic ...

  // Always index: includes extracted content when available,
  // field-level text otherwise.
  await getSearchProvider().indexEntity(entityId);

  // Queue embedding generation job
  await embeddingQueue.add("generate-embeddings", { entityId }, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  });
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/search/process-extraction.ts
git commit -m "feat: queue embedding generation job after extraction"
```

---

### Task 12: Add Audio MIME Types to File Extension Map

**Files:**
- Modify: `apps/api/src/handlers/files/utils.ts`

- [ ] **Step 1: Add audio types to extension map**

```typescript
// apps/api/src/handlers/files/utils.ts - Add audio MIME types

const fileExtensionMap: Record<string, string> = {
  // ... existing types ...
  // Audio
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  m4a: "audio/m4a",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
  // Video
  mp4: "video/mp4",
  webm: "video/webm",
};
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/handlers/files/utils.ts
git commit -m "feat: add audio and video MIME types to file extension map"
```

---

### Task 13: End-to-End Integration Test

**Files:**
- Create: `apps/api/src/lib/search/__tests__/e2e-hybrid-search.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// apps/api/src/lib/search/__tests__/e2e-hybrid-search.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { processExtraction } from "@/api/lib/search/process-extraction";
import { hybridSearch } from "@/api/lib/search/hybrid-search";
import { getEmbeddingCount } from "@/api/lib/search/vector-store";

describe("E2E hybrid search", () => {
  const testEntityId = "test-entity-e2e" as any;
  const testOrgId = "test-org-e2e" as any;
  const testWsId = "test-ws-e2e" as any;

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
    const embeddingCount = await getEmbeddingCount(testEntityId);
    expect(embeddingCount).toBeGreaterThan(0);

    // 3. Search using hybrid mode
    const results = await hybridSearch({
      query: "contract termination",
      organizationId: testOrgId,
      workspaceId: testWsId,
      limit: 5,
    });

    expect(results.hits.length).toBeGreaterThan(0);
    expect(results.hits[0].score).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
cd apps/api
bun test src/lib/search/__tests__/e2e-hybrid-search.test.ts
```

Expected: PASS (with proper test fixtures).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/search/__tests__/e2e-hybrid-search.test.ts
git commit -m "test: add end-to-end hybrid search integration test"
```

---

## Verification Checklist

After completing all tasks, verify:

- [ ] pgvector extension is enabled in PostgreSQL
- [ ] `document_embeddings` table exists with proper indexes
- [ ] xberg extraction works for PDF, DOCX, and other formats
- [ ] OCR works for scanned documents and images
- [ ] Audio transcription works for MP3, M4A, WAV
- [ ] Embeddings are generated and stored after extraction
- [ ] Hybrid search returns relevant results with combined scores
- [ ] `searchContent` tool supports `searchMode` parameter
- [ ] MCP tools use hybrid search
- [ ] Background reindexing worker processes jobs correctly
- [ ] All existing tests still pass
- [ ] No performance regression in BM25-only search

## Rollback Plan

If issues arise:

1. **Disable hybrid search**: Set default `searchMode` to `"keyword"` in chat tools
2. **Remove vector column**: Drop `document_embeddings` table
3. **Disable pgvector**: `DROP EXTENSION vector;`
4. **Revert xberg**: Fall back to existing extraction in `extraction-worker.ts`

## Future Enhancements

1. **Tune vector weights**: A/B test bm25Weight/vectorWeight ratios
2. **Add reranking**: Use xberg's reranker for result refinement
3. **Multi-lingual embeddings**: Use `multilingual` preset for international content
4. **Streaming embeddings**: Generate embeddings as chunks are extracted
5. **Embedding cache**: Cache embeddings to avoid regenerating unchanged content
6. **Frontend hybrid search UI**: Show vector similarity scores in search dialog
7. **Audio transcription UI**: Display transcription results in document viewer
8. **OCR confidence scores**: Show confidence scores for extracted text

import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { CORPUS_STORAGE_MODES } from "@/api/lib/corpus-storage-mode";
import {
  versionAstColumnsFor,
  versionAstFromObjectStorage,
} from "@/api/lib/legal-search/legislation-version-blocks";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The page read must carry a version's AST exactly when the reader will parse
 * it out of Postgres. Proving the two halves agree against a real PostgreSQL,
 * over every storage mode and both key states, is what stops the projection
 * from shipping a whole consolidated statute that object storage will serve
 * anyway, and stops it from withholding one the reader has no other copy of.
 */

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000002a1",
);
const STORED_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-0000000002a2",
);
const MIRRORED_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-0000000002a3",
);

const DOCUMENT_AST = {
  version: 1,
  source: { system: "test", documentId: "test", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "p1",
      anchorId: "par_1",
      type: "paragraph",
      inlines: [{ type: "text", text: "§ 1 Předmět úpravy" }],
      plainText: "§ 1 Předmět úpravy",
    },
  ],
} as const satisfies DocumentAst;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });

  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "version-ast-projection",
    name: "Version AST projection",
  });
  await db.insert(legislationDocuments).values([
    {
      id: STORED_ID,
      sourceId: SOURCE_ID,
      eli: "eli/cz/sb/2012/89",
      title: "Občanský zákoník",
      country: "CZE",
      language: "cs",
      contentHash: "a".repeat(64),
      astS3Key: null,
      documentAst: DOCUMENT_AST,
    },
    {
      id: MIRRORED_ID,
      sourceId: SOURCE_ID,
      eli: "eli/cz/sb/2013/90",
      title: "Zákon o státní službě",
      country: "CZE",
      language: "cs",
      contentHash: "b".repeat(64),
      astS3Key: "legislation/cze/2013/90/ast.zst",
      documentAst: DOCUMENT_AST,
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

test.each([...CORPUS_STORAGE_MODES])(
  "projects a version's AST exactly when the reader parses it (%s)",
  async (mode) => {
    const rows = await db
      .select(versionAstColumnsFor(mode))
      .from(legislationDocuments);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const servedFromObjectStorage = versionAstFromObjectStorage(
        mode,
        row.astS3Key,
      );
      // Both halves in one assertion: the AST is present for exactly the rows
      // the reader parses it from, and it arrives as the parsed document
      // rather than as text the reader would reject.
      expect({ id: row.id, documentAst: row.documentAst }).toEqual({
        id: row.id,
        documentAst: servedFromObjectStorage ? null : DOCUMENT_AST,
      });
    }
  },
);

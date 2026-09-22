import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { CORPUS_STORAGE_MODES } from "@/api/lib/corpus-storage-mode";
import {
  readStoredVersionAst,
  versionAstColumnsFor,
  versionPayloadFromObjectStorage,
  versionTextColumnsFor,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
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

const FULLTEXT = "§ 1 Předmět úpravy";

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
      textS3Key: null,
      fulltext: FULLTEXT,
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
      textS3Key: "legislation/cze/2013/90/text.zst",
      fulltext: FULLTEXT,
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
      const servedFromObjectStorage = versionPayloadFromObjectStorage(
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

test.each([...CORPUS_STORAGE_MODES])(
  "projects a version's text exactly when the reader takes it from Postgres (%s)",
  async (mode) => {
    const rows = await db
      .select({ id: legislationDocuments.id, ...versionTextColumnsFor(mode) })
      .from(legislationDocuments);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const servedFromObjectStorage = versionPayloadFromObjectStorage(
        mode,
        row.textS3Key,
      );
      expect({ id: row.id, fulltext: row.fulltext }).toEqual({
        id: row.id,
        fulltext: servedFromObjectStorage ? null : FULLTEXT,
      });
    }
  },
);

/**
 * The fallback runs in a transaction of its own, after the read that gated the
 * version has committed. A publisher who withdraws redistribution in between
 * must not have the withdrawn text served by the degraded path.
 */
test("the fallback read stops serving a version whose source was revoked", async () => {
  const legislationDb: LegislationReadDb = async (fn) =>
    await db.transaction(
      async (tx) => await fn(asTestRaw<LegislationReadTransaction>(tx)),
    );
  const sourceId = toSafeId<"legislationSource">(
    "0198e331-e578-7000-8000-0000000002b1",
  );
  const documentId = toSafeId<"legislationDocument">(
    "0198e331-e578-7000-8000-0000000002b2",
  );

  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "version-ast-revocation",
    name: "Version AST revocation",
    descriptor: {
      license: "permitted-redistribution",
      attribution: "Publisher",
      allowsRedistribution: true,
      allowsDerivedAi: false,
    },
  });
  await db.insert(legislationDocuments).values({
    id: documentId,
    sourceId,
    eli: "eli/cz/sb/2014/91",
    title: "Zákon o kybernetické bezpečnosti",
    country: "CZE",
    language: "cs",
    contentHash: "c".repeat(64),
    astS3Key: "legislation/cze/2014/91/ast.zst",
    documentAst: DOCUMENT_AST,
  });

  expect(await readStoredVersionAst({ legislationDb, id: documentId })).toEqual(
    DOCUMENT_AST,
  );

  expect(
    await readStoredVersionAst({
      legislationDb,
      id: documentId,
      purpose: "derived-ai",
    }),
  ).toBeNull();

  await db
    .update(legislationSources)
    .set({
      descriptor: {
        license: "restricted",
        attribution: "Publisher",
        allowsRedistribution: false,
        allowsDerivedAi: false,
      },
    })
    .where(eq(legislationSources.id, sourceId));

  expect(
    await readStoredVersionAst({ legislationDb, id: documentId }),
  ).toBeNull();
});

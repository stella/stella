import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  PUBLIC_LEGISLATION_COUNTRIES,
  PUBLIC_LEGISLATION_PAGE_COUNTRIES,
} from "@stll/api-contract/legislation-publication";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { readLegislationProvisionVersions } from "@/api/handlers/legislation/provision-versions";
import { toSafeId } from "@/api/lib/branded-types";
import { CORPUS_STORAGE_MODES } from "@/api/lib/corpus-storage-mode";
import {
  canonicalLegislationAstSource,
  canonicalLegislationTextSource,
} from "@/api/lib/legal-search/legislation-canonical-source";
import {
  readStoredVersionAst,
  versionAstColumnsFor,
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
    family: "decision",
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

test.each(CORPUS_STORAGE_MODES)(
  "projects a version's AST exactly when the reader parses it (%s)",
  async (mode) => {
    const rows = await db
      .select(versionAstColumnsFor(mode))
      .from(legislationDocuments);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const servedFromObjectStorage =
        canonicalLegislationAstSource(row, mode).type === "object_storage";
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

test.each(CORPUS_STORAGE_MODES)(
  "projects a version's text exactly when the reader takes it from Postgres (%s)",
  async (mode) => {
    const rows = await db
      .select({ id: legislationDocuments.id, ...versionTextColumnsFor(mode) })
      .from(legislationDocuments);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const servedFromObjectStorage =
        canonicalLegislationTextSource(row, mode).type === "object_storage";
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

  expect(
    await readStoredVersionAst({
      surface: "search",
      legislationDb,
      id: documentId,
    }),
  ).toEqual(DOCUMENT_AST);

  expect(
    await readStoredVersionAst({
      surface: "search",
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
    await readStoredVersionAst({
      surface: "search",
      legislationDb,
      id: documentId,
    }),
  ).toBeNull();
});

/**
 * Each surface reads its own country list in SQL: a pages-public country's
 * stored version is served to its pages and refused to search, an admitted one
 * is served to both, and a closed one to neither.
 */
test("the stored version read gates each surface by its own country list", async () => {
  const legislationDb: LegislationReadDb = async (fn) =>
    await db.transaction(
      async (tx) => await fn(asTestRaw<LegislationReadTransaction>(tx)),
    );
  const sourceId = toSafeId<"legislationSource">(
    "0198e331-e578-7000-8000-0000000002c0",
  );
  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "version-ast-surfaces",
    name: "Version AST surfaces",
  });
  const closed = "AUT";
  expect(PUBLIC_LEGISLATION_PAGE_COUNTRIES).not.toContain(closed);
  const countries = [
    ...new Set<string>([
      ...PUBLIC_LEGISLATION_COUNTRIES,
      ...PUBLIC_LEGISLATION_PAGE_COUNTRIES,
      closed,
    ]),
  ];

  for (const [index, country] of countries.entries()) {
    const id = toSafeId<"legislationDocument">(
      `0198e331-e578-7000-8000-0000000002${(0xd0 + index).toString(16)}`,
    );
    await db.insert(legislationDocuments).values({
      id,
      sourceId,
      eli: `eli/${country.toLowerCase()}/test/${index}`,
      title: `Surface statute ${country}`,
      country,
      language: "cs",
      contentHash: index.toString(16).padStart(64, "0"),
      astS3Key: null,
      documentAst: DOCUMENT_AST,
    });

    const served = (list: readonly string[]) =>
      list.some((candidate) => candidate === country) ? DOCUMENT_AST : null;
    expect({
      country,
      pages: await readStoredVersionAst({
        surface: "pages",
        legislationDb,
        id,
      }),
      search: await readStoredVersionAst({
        surface: "search",
        legislationDb,
        id,
      }),
    }).toEqual({
      country,
      pages: served(PUBLIC_LEGISLATION_PAGE_COUNTRIES),
      search: served(PUBLIC_LEGISLATION_COUNTRIES),
    });
  }
});

/**
 * The provision read takes its versions from this lookup and then reads each
 * AST inline or from object storage, neither of which gates by country. So the
 * lookup itself must answer per surface: an agent read on the search surface
 * never receives a pages-public version, however its AST is stored.
 */
test("the provision version lookup answers each surface by its own country list", async () => {
  const legislationDb: LegislationReadDb = async (fn) =>
    await db.transaction(
      async (tx) => await fn(asTestRaw<LegislationReadTransaction>(tx)),
    );
  const sourceId = toSafeId<"legislationSource">(
    "0198e331-e578-7000-8000-0000000002e0",
  );
  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "provision-version-surfaces",
    name: "Provision version surfaces",
  });
  const closed = "AUT";
  expect(PUBLIC_LEGISLATION_PAGE_COUNTRIES).not.toContain(closed);
  const countries = [
    ...new Set<string>([
      ...PUBLIC_LEGISLATION_COUNTRIES,
      ...PUBLIC_LEGISLATION_PAGE_COUNTRIES,
      closed,
    ]),
  ];

  const rows = countries.flatMap((country, index) =>
    (["inline", "object-storage"] as const).map((storage, offset) => ({
      country,
      storage,
      id: toSafeId<"legislationDocument">(
        `0198e331-e578-7000-8000-000000000${(0x3_00 + index * 2 + offset).toString(16)}`,
      ),
    })),
  );
  for (const [index, row] of rows.entries()) {
    await db.insert(legislationDocuments).values({
      id: row.id,
      sourceId,
      eli: `eli/${row.country.toLowerCase()}/provision/${index}`,
      title: `Provision statute ${row.country} ${row.storage}`,
      country: row.country,
      language: "cs",
      contentHash: (0x1_00 + index).toString(16).padStart(64, "0"),
      astS3Key:
        row.storage === "inline"
          ? null
          : `legislation/${row.country.toLowerCase()}/${index}/ast.zst`,
      documentAst: DOCUMENT_AST,
    });
  }

  const answered = async (surface: "pages" | "search") =>
    (
      await readLegislationProvisionVersions({
        documentIds: rows.map(({ id }) => id),
        legislationDb,
        surface,
      })
    )
      .map(({ id }) => String(id))
      .toSorted();
  const expected = (list: readonly string[]) =>
    rows
      .filter(({ country }) => list.some((candidate) => candidate === country))
      .map(({ id }) => String(id))
      .toSorted();

  expect(await answered("pages")).toEqual(
    expected(PUBLIC_LEGISLATION_PAGE_COUNTRIES),
  );
  expect(await answered("search")).toEqual(
    expected(PUBLIC_LEGISLATION_COUNTRIES),
  );
});

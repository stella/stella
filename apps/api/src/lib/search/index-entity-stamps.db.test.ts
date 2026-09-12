import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { organization } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import {
  entities,
  entityVersions,
  searchDocuments,
  workspaces,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { toDocumentReference } from "@/api/lib/document-reference";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import type { IndexEntityDependencies } from "@/api/lib/search/index-entity";
import {
  buildPlainSearchTsQuery,
  buildSearchTsQuery,
} from "@/api/lib/search/query";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

setDefaultTimeout(120_000);

/**
 * A document reference is a two-runtime contract: the projection writes the
 * stamps in JavaScript, and PostgreSQL decides what they tokenize to. Its
 * default parser reads `2026/001/015.v3` as a single `file` token, so a
 * reader typing `2026/001/015` matches nothing unless that form is its own
 * token. Neither side can be checked alone, and a hand-written list of
 * expected lexemes would only record today's parser.
 *
 * So both halves here are the production ones: the projection is written by
 * `upsertSearchDocument`, and every query is compiled by `buildSearchTsQuery`
 * exactly as the search endpoint compiles it.
 */

const ORGANIZATION_ID = "org-document-reference-search";
const SEED_AT = new Date("2026-01-01T00:00:00.000Z");

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const workspaceId = toSafeId<"workspace">(uuid(1));
const entityId = toSafeId<"entity">(uuid(2));
const versionId = (versionNumber: number): SafeId<"entityVersion"> =>
  toSafeId<"entityVersion">(uuid(100 + versionNumber));

const FIRST_MATTER_REFERENCE = "2026/001";
const SECOND_MATTER_REFERENCE = "2027/004";
const FIRST_DOC_SEQUENCE = 15;
const SECOND_DOC_SEQUENCE = 2;

/** The two references this one document carried, before and after a move. */
const firstReference = `${FIRST_MATTER_REFERENCE}/015`;
const secondReference = `${SECOND_MATTER_REFERENCE}/002`;
const NEVER_CARRIED_REFERENCE = "2026/002/015";
/** Shares no number with anything the fixture indexes. */
const UNRELATED_REFERENCE = "3011/777/888";

const seededVersions = [
  {
    stamp: toDocumentReference({
      matterReference: FIRST_MATTER_REFERENCE,
      docSequence: FIRST_DOC_SEQUENCE,
      versionNumber: 1,
    }),
    versionNumber: 1,
  },
  {
    stamp: toDocumentReference({
      matterReference: SECOND_MATTER_REFERENCE,
      docSequence: SECOND_DOC_SEQUENCE,
      versionNumber: 2,
    }),
    versionNumber: 2,
  },
  {
    stamp: toDocumentReference({
      matterReference: SECOND_MATTER_REFERENCE,
      docSequence: SECOND_DOC_SEQUENCE,
      versionNumber: 3,
    }),
    versionNumber: 3,
  },
] as const;

const currentVersionNumber = 3;

type TestPglite = Awaited<ReturnType<typeof createTestPglite>>;

/** The projection reads through the relational API, so the handle carries
 *  the production relations. Inferred, never annotated: drizzle's type
 *  parameters are positional and an explicit one silently lands in the
 *  client slot. */
const createProjectionDb = (pglite: TestPglite) =>
  drizzle({ client: pglite, relations: databaseRelations });

let client: TestPglite;
let db: ReturnType<typeof createProjectionDb>;

/**
 * PGlite ships no `unaccent`, so the projection's own SQL cannot run without
 * a stand-in. References are ASCII, where the extension is the identity, and
 * the real extension's Latin fold is pinned separately by the `foldToAscii` /
 * `unaccent` parity test; the fixture assertion below keeps this double from
 * covering anything it is not exact for.
 */
const installUnaccentDouble = async (): Promise<void> => {
  await db.execute(
    sql`CREATE FUNCTION public.unaccent(input text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS 'SELECT input'`,
  );
};

type ProjectionDatabase = NonNullable<IndexEntityDependencies["database"]>;

/**
 * `execute` yields a result object on PGlite and a row array on the
 * production driver. That one difference is all the shim adapts; `query` and
 * `select` are handed over as they are, so neither can drift from what the
 * projection calls.
 */
const projectionDatabase = (): ProjectionDatabase =>
  asTestRaw<ProjectionDatabase>({
    query: db.query,
    select: db.select.bind(db),
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      await db.transaction(
        async (tx) =>
          await run({
            execute: async (query: SQL) => (await tx.execute(query)).rows,
          }),
      ),
  });

const indexEntity = async (): Promise<void> => {
  await upsertSearchDocument(entityId, {
    database: projectionDatabase(),
    syncActivity: async () => undefined,
  });
};

const matchedBy = async (tsQuery: SQL): Promise<boolean> => {
  const [row] = await db
    .select({ matched: sql<boolean>`${searchDocuments.tsv} @@ ${tsQuery}` })
    .from(searchDocuments)
    .where(eq(searchDocuments.entityId, entityId));
  return row?.matched === true;
};

/** What the search endpoint runs. */
const matchesSearch = async (query: string): Promise<boolean> =>
  await matchedBy(buildSearchTsQuery(query));

/**
 * The exact half of that query. `buildSearchTsQuery` ORs a deliberately
 * loose prefix fallback over it, which recalls anything sharing a single
 * number with the typed reference (`2026` alone is enough, stamps or not).
 * Whether a reference identifies this document is decided here.
 */
const matchesReferenceExactly = async (query: string): Promise<boolean> =>
  await matchedBy(buildPlainSearchTsQuery(query));

beforeAll(async () => {
  client = await createTestPglite();
  db = createProjectionDb(client);
  await installUnaccentDouble();

  await db.insert(organization).values({
    createdAt: SEED_AT,
    id: ORGANIZATION_ID,
    name: "Document reference search",
    slug: ORGANIZATION_ID,
  });
  await db.insert(workspaces).values({
    createdAt: SEED_AT,
    id: workspaceId,
    lastActivityAt: SEED_AT,
    name: "Moved matter",
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    reference: SECOND_MATTER_REFERENCE,
  });
  await db.insert(entities).values({
    createdAt: SEED_AT,
    id: entityId,
    kind: "document",
    name: "Share purchase agreement",
    updatedAt: SEED_AT,
    workspaceId,
  });
  await db.insert(entityVersions).values(
    seededVersions.map(({ stamp, versionNumber }) => ({
      createdAt: SEED_AT,
      entityId,
      id: versionId(versionNumber),
      stamp,
      versionNumber,
      workspaceId,
    })),
  );
  await db
    .update(entities)
    .set({ currentVersionId: versionId(currentVersionNumber) })
    .where(eq(entities.id, entityId));

  await indexEntity();
}, 300_000);

afterAll(async () => {
  await client.close();
});

test("the projection it writes is ASCII, where the unaccent double is exact", async () => {
  const [row] = await db
    .select({ searchableText: searchDocuments.searchableText })
    .from(searchDocuments)
    .where(eq(searchDocuments.entityId, entityId));

  expect(row?.searchableText).toContain(firstReference);
  expect(row?.searchableText).toMatch(/^\p{ASCII}*$/u);
});

test("a document is found by every reference it has carried", async () => {
  for (const reference of [
    ...seededVersions.map(({ stamp }) => stamp),
    firstReference,
    secondReference,
  ]) {
    expect(await matchesSearch(reference)).toBe(true);
    expect(await matchesReferenceExactly(reference)).toBe(true);
  }
});

test("a reference the document never carried does not identify it", async () => {
  // Same year and sequence as a reference it does carry, different matter:
  // the whole stamp is one token, so a near miss is still a miss.
  expect(await matchesReferenceExactly(NEVER_CARRIED_REFERENCE)).toBe(false);
  expect(await matchesReferenceExactly(`${firstReference}.v9`)).toBe(false);
  expect(await matchesSearch(UNRELATED_REFERENCE)).toBe(false);
});

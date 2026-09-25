import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { searchGlobal } from "@/api/lib/search/index-global";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const LANGUAGE_GROUP_KEY = "group:indemnity";

const sourceId = createSafeId<"caseLawSource">();
const sluggedId = createSafeId<"caseLawDecision">();
const unsluggedId = createSafeId<"caseLawDecision">();
const englishId = createSafeId<"caseLawDecision">();
const frenchId = createSafeId<"caseLawDecision">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;
let scopedDb: ScopedDb;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    // Tenant search runs as the request role; public case law is readable
    // under it without any workspace in scope.
    scopedDb = executeRowsScopedDb(
      createScopedDb(
        markRlsDatabase(db),
        [],
        toSafeId<"organization">("org_1"),
        toSafeId<"user">("user_1"),
      ),
    );
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          // SAFETY: the role transaction has the same Drizzle read surface as
          // the public-law handle; writes remain on the owner database above.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite test transaction stands in for the public read handle
          await fn(tx as unknown as CaseLawPublicReadTransaction),
      );
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "1 As 1/2024",
        country: "CZE",
        court: "Nejvyšší správní soud",
        id: sluggedId,
        language: "cs",
        slug: "1-as-1-2024",
        sourceId,
      },
      {
        caseNumber: "2 As 2/2024",
        country: "CZE",
        court: "Nejvyšší správní soud",
        id: unsluggedId,
        language: "cs",
        sourceId,
      },
      {
        caseNumber: "C-1/24",
        country: "CZE",
        court: "Court of Justice",
        id: englishId,
        language: "en",
        languageGroupKey: LANGUAGE_GROUP_KEY,
        slug: "c-1-24-en",
        sourceId,
      },
      {
        caseNumber: "C-1/24",
        country: "CZE",
        court: "Cour de justice",
        id: frenchId,
        language: "fr",
        languageGroupKey: LANGUAGE_GROUP_KEY,
        slug: "c-1-24-fr",
        sourceId,
      },
    ]);
    await db.insert(caseLawSearchDocuments).values(
      [sluggedId, unsluggedId, englishId, frenchId].map((decisionId) => ({
        decisionId,
      })),
    );
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

// The type filter alone selects case law: a text query would need the
// unaccent search configuration the test database does not install.
const searchCaseLaw = async () =>
  await searchGlobal(
    {
      query: "",
      organizationId: toSafeId<"organization">("org_1"),
      userId: toSafeId<"user">("user_1"),
      accessibleWorkspaceIds: [],
      selectedWorkspaceIds: [],
      types: ["case-law"],
      editedByUserIds: [],
      mimeTypes: [],
      limit: 10,
    },
    {
      scopedDb,
      readLanguageAlternates: async (languageGroupKeys) =>
        await readPublicDecisionLanguageAlternatesByGroup({
          caseLawDb,
          languageGroupKeys,
        }),
    },
  );

const caseLawHit = async (decisionId: string) => {
  const hit = (await searchCaseLaw()).hits.find(
    (candidate) =>
      candidate.type === "case-law" && candidate.decisionId === decisionId,
  );
  if (hit?.type !== "case-law") {
    throw new Error(`expected a case-law hit for ${decisionId}`);
  }
  return hit;
};

test("a case-law hit carries the stored slug and language", async () => {
  const hit = await caseLawHit(sluggedId);

  expect(hit.slug).toBe("1-as-1-2024");
  expect(hit.language).toBe("cs");
  expect(hit.languageAlternates).toEqual([]);
});

test("a case-law hit without a stored slug says so", async () => {
  const hit = await caseLawHit(unsluggedId);

  expect(hit.slug).toBeNull();
  expect(hit.language).toBe("cs");
});

test("a multilingual case-law hit carries only its languages", async () => {
  const hit = await caseLawHit(englishId);

  expect(hit.language).toBe("en");
  expect(hit.languageAlternates).toEqual([
    { language: "en" },
    { language: "fr" },
  ]);
});

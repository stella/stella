import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { readLatestDecisionsByCourt } from "@/api/handlers/case-law/decisions/latest";
import { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import { listSitemapShardDecisionsHandler } from "@/api/handlers/case-law/decisions/sitemap";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import {
  publishedCaseLawDecision,
  publishedCaseLawDecisionSqlFor,
} from "@/api/lib/case-law/published-decisions";
import {
  markListingOnly,
  partialObservationFromMetadata,
} from "@/api/lib/legal-search/ingestion-normalization";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { readPgFtsBrowseFacets } from "@/api/lib/legal-search/pg-fts-browse-facets";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * A listing-only decision (guide rule 20) is durable and unpublished: the
 * publisher listed it, its detail never arrived, and it stays in the table so
 * a later observation can enrich the same row. Until that observation no
 * public surface may show it, and when it arrives every surface must.
 *
 * Executed against Postgres because the marker is read two ways — by the SQL
 * predicate the public reads carry and by the JavaScript reader the pipeline
 * and the corpus projection use. The first test holds those two to the same
 * answer across the shapes a stored blob can take; the rest drive surfaces.
 */

const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"caseLawSource">();
const publishedId = createSafeId<"caseLawDecision">();
const pendingId = createSafeId<"caseLawDecision">();
const groupPendingId = createSafeId<"caseLawDecision">();
const groupPublishedId = createSafeId<"caseLawDecision">();

const COURT = "Nejvyšší soud";
const GROUP_KEY = "ECLI:CZ:NS:2026:LISTING.ONLY";
/** The marker-shape rows live outside the country every surface below reads. */
const SHAPE_COUNTRY = "SVK";

const listingOnly = {
  _stellaPartialObservation: {
    caseNumberIsPlaceholder: false,
    isListingOnly: true,
  },
};

/** Every shape the marker can take in a stored blob, and what it means. */
const markerShapes = [
  { hasDetail: true, label: "no marker", metadata: {} },
  {
    hasDetail: true,
    label: "marker says false",
    metadata: { _stellaPartialObservation: { isListingOnly: false } },
  },
  {
    hasDetail: true,
    label: "the key on another path",
    metadata: { isListingOnly: true },
  },
  {
    hasDetail: true,
    label: "the marker is not an object",
    metadata: { _stellaPartialObservation: "isListingOnly" },
  },
  { hasDetail: false, label: "marker says true", metadata: listingOnly },
];

/** One seeded row per shape, so the expectation and the seed cannot drift. */
const shapeRows = markerShapes.map((shape) => ({
  id: createSafeId<"caseLawDecision">(),
  hasDetail: shape.hasDetail,
  metadata: shape.metadata,
}));

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

type SeedOptions = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
  country?: string;
  createdAt: Date;
  language?: string;
  languageGroupKey?: string | null;
  metadata: Record<string, unknown>;
};

const seedDecision = ({
  id,
  caseNumber,
  country = "CZE",
  createdAt,
  language = "cs",
  languageGroupKey = null,
  metadata,
}: SeedOptions) => ({
  id,
  sourceId,
  caseNumber,
  court: COURT,
  country,
  language,
  languageGroupKey,
  decisionDate: "2026-03-04",
  createdAt,
  metadata,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  const readDb = async <T>(
    read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the reads use.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await read(tx);
    });
  // SAFETY: brand-only wrapper around the read-role transaction helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db.insert(caseLawSources).values([
    caseLawSourceRow({
      adapterKey: "listing",
      id: sourceId,
      name: "listing",
    }),
  ]);
  await db.insert(caseLawDecisions).values([
    seedDecision({
      id: publishedId,
      caseNumber: "1 Cdo 1/2026",
      createdAt: new Date(2026, 2, 4, 9),
      metadata: {},
    }),
    seedDecision({
      id: pendingId,
      caseNumber: "2 Cdo 2/2026",
      createdAt: new Date(2026, 2, 4, 10),
      metadata: listingOnly,
    }),
    // The older version of a multilingual decision is the one the browse walk
    // takes as the group's representative. Listing-only, it must neither be
    // listed itself nor keep the version that is listable out of the page.
    seedDecision({
      id: groupPendingId,
      caseNumber: "3 Cdo 3/2026",
      createdAt: new Date(2026, 2, 4, 11),
      language: "en",
      languageGroupKey: GROUP_KEY,
      metadata: listingOnly,
    }),
    seedDecision({
      id: groupPublishedId,
      caseNumber: "3 Cdo 3/2026",
      createdAt: new Date(2026, 2, 4, 12),
      languageGroupKey: GROUP_KEY,
      metadata: {},
    }),
    ...shapeRows.map((shape, index) =>
      seedDecision({
        id: shape.id,
        caseNumber: `shape ${index}`,
        country: SHAPE_COUNTRY,
        createdAt: new Date(2026, 2, 5, index),
        language: "sk",
        metadata: shape.metadata,
      }),
    ),
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const listedIds = async () => {
  const result = await listDecisionsHandler(
    { country: "CZE", limit: 50 },
    caseLawDb,
    async () => courtWeightMapFromSeed(),
  );
  if (!("items" in result)) {
    throw new Error("list failed");
  }
  return result.items.map((item) => item.id);
};

test(
  "both spellings of the predicate answer what the metadata reader answers",
  async () => {
    const expected = shapeRows
      .flatMap((shape) => (shape.hasDetail ? [shape.id] : []))
      .toSorted();

    // The reader is the other half of the mirror: if it disagrees, the
    // pipeline's idea of listing-only and the public reads' idea have parted.
    expect(
      shapeRows
        .flatMap((shape) =>
          partialObservationFromMetadata(shape.metadata).isListingOnly
            ? []
            : [shape.id],
        )
        .toSorted(),
    ).toEqual(expected);

    const columnForm = await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.country, SHAPE_COUNTRY),
          publishedCaseLawDecision,
        ),
      );
    expect(columnForm.map((row) => row.id).toSorted()).toEqual(expected);

    const rawForm = await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.country, SHAPE_COUNTRY),
          sql.raw(publishedCaseLawDecisionSqlFor("case_law_decisions")),
        ),
      );
    expect(rawForm.map((row) => row.id).toSorted()).toEqual(expected);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the marker a write sets in SQL is the one the pipeline sets in JavaScript",
  async () => {
    // Two writers of one marker: the first write of a decision builds the
    // metadata in JavaScript, a refresh sets it inside the guarded statement.
    const marked = await db
      .select({
        id: caseLawDecisions.id,
        metadata: metadataMarkedListingOnly(caseLawDecisions.metadata),
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.country, SHAPE_COUNTRY));

    expect(
      Object.fromEntries(marked.map((row) => [row.id, row.metadata])),
    ).toEqual(
      Object.fromEntries(
        shapeRows.map((shape) => [shape.id, markListingOnly(shape.metadata)]),
      ),
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "no public surface shows a listing-only row",
  async () => {
    expect((await listedIds()).toSorted()).toEqual(
      [publishedId, groupPublishedId].toSorted(),
    );

    const shelf = await readLatestDecisionsByCourt({
      caseLawDb,
      country: "CZE",
      courts: [{ court: COURT, tierLabel: "supreme" }],
    });
    expect(
      shelf.flatMap((group) => group.decisions.map((row) => row.id)).toSorted(),
    ).toEqual([publishedId, groupPublishedId].toSorted());

    const shard = await listSitemapShardDecisionsHandler(
      { bucket: "all", country: "cze", month: "03", year: "2026" },
      caseLawDb,
    );
    if (!("items" in shard)) {
      throw new Error("sitemap shard failed");
    }
    expect(shard.items.map((item) => item.id).toSorted()).toEqual(
      [publishedId, groupPublishedId].toSorted(),
    );

    const facets = await caseLawDb(
      async (tx) =>
        await readPgFtsBrowseFacets(tx, {
          excludedSourceIds: [],
          jurisdiction: "CZE",
          limit: 10,
        }),
    );
    expect(facets.court).toEqual([{ count: 2, value: COURT }]);

    // A listing-only sibling is not a version a reader can open, so it is not
    // offered as one: the group is left with a single version, which is the
    // domain's "nothing to choose from".
    const alternates = await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: [GROUP_KEY],
    });
    expect(alternates.alternatesFor(GROUP_KEY)).toEqual([]);

    // The subject gate answers the decision page, both citation lists and the
    // provisions at once: none of them exist for a listing-only row.
    expect(
      await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: pendingId },
        async (subject) => subject.id,
      ),
    ).toBeNull();
    expect(
      await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: publishedId },
        async (subject) => subject.id,
      ),
    ).toBe(publishedId);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the row is published the moment its detail arrives",
  async () => {
    await db
      .update(caseLawDecisions)
      .set({ metadata: {} })
      .where(eq(caseLawDecisions.id, groupPendingId));

    // The enriched version is older, so it becomes the group's representative
    // and brings the other version with it as an alternate.
    expect((await listedIds()).toSorted()).toEqual(
      [publishedId, groupPendingId].toSorted(),
    );
    const alternates = await readPublicDecisionLanguageAlternatesByGroup({
      caseLawDb,
      languageGroupKeys: [GROUP_KEY],
    });
    expect(
      alternates.alternatesFor(GROUP_KEY).map((alternate) => alternate.id),
    ).toEqual([groupPublishedId, groupPendingId]);
    expect(
      await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: groupPendingId },
        async (subject) => subject.id,
      ),
    ).toBe(groupPendingId);
  },
  DB_TEST_TIMEOUT_MS,
);

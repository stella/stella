import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";
import { drawPropertySamples } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  caseLawCitationArrivals,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import {
  citationArrivalsOf,
  drainCitationArrivals,
  enqueueCitationArrivals,
  reopenCitationsForArrivals,
  reopenCitationsForDecisionIdentifiers,
  UNKEYED_CITATIONS_REMAIN_SQL,
} from "@/api/handlers/case-law/citation-arrivals";
import type { CitationArrival } from "@/api/handlers/case-law/citation-arrivals";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import {
  CITATION_IDENTIFIER_MATCH_KEY_FUNCTION,
  CITATION_IDENTIFIER_MATCH_KEY_TRIGGER,
} from "@/api/handlers/case-law/citation-identifier-match-key";
import { citationResolutionPolicyRows } from "@/api/handlers/case-law/citation-jurisdiction-policy";
import {
  CITATION_RESOLUTION_STATUS,
  citationReopenableByKeySql,
  effectiveCitationIdentifierTypeSql,
  effectiveCitationIdentifierValueSql,
} from "@/api/handlers/case-law/citation-resolution-status";
import type { CitationResolutionStatus } from "@/api/handlers/case-law/citation-resolution-status";
import { CASE_LAW_REMOVAL_STORES } from "@/api/handlers/case-law/removal-stores";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  caseNumberKeysMatchSql,
  caseNumberMatchKey,
  caseNumberMatchKeySql,
} from "@/api/lib/case-law/case-number-match-key";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { citationMatchKeyBatchSql } from "../../db/citation-identifier-match-key-backfill";

/**
 * The arrival reopen reads citations by their stored match key, in one
 * statement per drain. These cases hold it to the per-decision statement it
 * replaced, kept here verbatim as the oracle: over generated corpora and over
 * real docket shapes, the drain reopens exactly the citations the old
 * statement selected for each of its decisions, before the stored keys are
 * written, while only some are, and after the repair has written them all.
 * The stored key itself is held to `caseNumberMatchKey`, whoever writes the
 * row.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const dialect = new PgDialect();

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

type StoredDecision = {
  id: SafeId<"caseLawDecision">;
  jurisdiction: CaseLawJurisdiction;
  decisionDate: string | null;
  identifiers: { type: DecisionIdentifierType; normalizedValue: string }[];
};

// ---------------------------------------------------------------------------
// The oracle: the per-decision statement this module replaced, as a read.

const policyRowsJson = JSON.stringify(
  citationResolutionPolicyRows().map(({ jurisdiction, resolvesTo }) => ({
    citing_country: jurisdiction,
    resolves_to: resolvesTo,
  })),
);

const legacyReopenSelectSql = ({
  id,
  jurisdiction,
  decisionDate,
  identifiers,
}: StoredDecision): SQL => {
  const arriving = JSON.stringify(
    identifiers.map(({ type, normalizedValue }) => ({
      type,
      normalized_value: normalizedValue,
    })),
  );
  const reachedFrom = sql`(
    SELECT pol.citing_country
      FROM jsonb_to_recordset(${policyRowsJson}::text::jsonb) AS pol(citing_country varchar, resolves_to varchar[])
     WHERE ${jurisdiction}::varchar = ANY (pol.resolves_to)
  )`;
  return sql`
    WITH arriving(type, normalized_value) AS (
      SELECT a.type, a.normalized_value
        FROM jsonb_to_recordset(${arriving}::text::jsonb) AS a(
          type varchar,
          normalized_value varchar
        )
    )
    SELECT citation.id::text AS id, 'revived' AS arm
      FROM ${caseLawCitations} citation, ${caseLawDecisions} citing
     WHERE citing.id = citation.citing_decision_id
       AND EXISTS (
         SELECT 1
         FROM arriving
         WHERE arriving.type = ${effectiveCitationIdentifierTypeSql(
           sql.raw("citation.identifier_type"),
         )}
           AND ${caseNumberKeysMatchSql(
             sql.raw("arriving.normalized_value"),
             effectiveCitationIdentifierValueSql(
               sql.raw("citation.normalized_identifier_value"),
               sql.raw("citation.citation_key"),
             ),
           )}
       )
       AND ${citationReopenableByKeySql(sql.raw("citation.resolution_status"))}
       AND citing.country IN ${reachedFrom}
       AND (
             citing.decision_date IS NULL
          OR ${decisionDate}::date IS NULL
          OR citing.decision_date >= ${decisionDate}::date
           )
    UNION ALL
    SELECT citation.id::text AS id, 'contested' AS arm
      FROM ${caseLawCitations} citation, ${caseLawDecisions} citing, ${caseLawDecisions} cited
     WHERE citing.id = citation.citing_decision_id
       AND cited.id = citation.cited_decision_id
       AND cited.id <> ${id}::uuid
       AND EXISTS (
         SELECT 1
         FROM arriving
         JOIN ${caseLawDecisionIdentifiers} cited_identifier
           ON cited_identifier.type = arriving.type
          AND ${caseNumberKeysMatchSql(
            sql.raw("cited_identifier.normalized_value"),
            sql.raw("arriving.normalized_value"),
          )}
         WHERE cited_identifier.decision_id = cited.id
       )
       AND citation.resolution_status = ${CITATION_RESOLUTION_STATUS.RESOLVED}
       AND citing.country IN ${reachedFrom}
       AND (
             citing.decision_date IS NULL
          OR ${decisionDate}::date IS NULL
          OR citing.decision_date >= ${decisionDate}::date
           )
  `;
};

type LegacySelection = { ids: string[]; revived: number; contested: number };

const legacySelection = async (
  decisions: readonly StoredDecision[],
): Promise<LegacySelection> => {
  const ids = new Set<string>();
  let revived = 0;
  let contested = 0;
  for (const decision of decisions) {
    // db-await-in-loop: the oracle is the per-decision statement, run per decision
    const rows = executedRows(
      await db.execute(legacyReopenSelectSql(decision)),
    );
    for (const row of rows) {
      if (!isRecord(row) || typeof row["id"] !== "string") {
        throw new TypeError("legacy reopen row without an id");
      }
      ids.add(row["id"]);
      if (row["arm"] === "revived") {
        revived++;
      } else {
        contested++;
      }
    }
  }
  return { ids: [...ids].toSorted(), revived, contested };
};

// ---------------------------------------------------------------------------
// The drain's statement, run and rolled back so every comparison reads one
// corpus.

class RolledBackError extends Error {
  readonly ids: readonly string[];

  constructor(ids: readonly string[]) {
    super("rolled back");
    this.name = "RolledBackError";
    this.ids = ids;
  }
}

const UNCAPPED = 1_000_000;

const batchedSelection = async (
  arrivals: readonly CitationArrival[],
): Promise<string[]> => {
  try {
    await runCitationGraphTransaction(db.transaction.bind(db), async (tx) => {
      const reopened = await reopenCitationsForArrivals(tx, arrivals, UNCAPPED);
      expect(reopened.citationIds).toHaveLength(reopened.reopened);
      throw new RolledBackError(reopened.citationIds);
    });
  } catch (error) {
    if (error instanceof RolledBackError) {
      return [...error.ids].toSorted();
    }
    throw error;
  }
  throw new Error("the reopen did not roll back");
};

const singleDecisionSelection = async (
  decision: StoredDecision,
): Promise<string[]> => {
  try {
    await runCitationGraphTransaction(db.transaction.bind(db), async (tx) => {
      const reopened = await reopenCitationsForDecisionIdentifiers(tx, {
        decisionId: decision.id,
        jurisdiction: decision.jurisdiction,
        decisionDate: decision.decisionDate,
        identifiers: decision.identifiers,
      });
      throw new RolledBackError(reopened.citationIds);
    });
  } catch (error) {
    if (error instanceof RolledBackError) {
      return [...error.ids].toSorted();
    }
    throw error;
  }
  throw new Error("the reopen did not roll back");
};

const arrivalsOf = (decisions: readonly StoredDecision[]) =>
  decisions.flatMap((decision) =>
    citationArrivalsOf({
      decisionId: decision.id,
      jurisdiction: decision.jurisdiction,
      decisionDate: decision.decisionDate,
      identifiers: decision.identifiers,
    }),
  );

// ---------------------------------------------------------------------------
// Corpora.

const resetCorpus = async () => {
  await client.exec(
    "TRUNCATE case_law_citation_arrivals, case_law_citations, case_law_decision_identifiers, case_law_decisions, case_law_sources CASCADE",
  );
};

type DecisionSeed = {
  jurisdiction: CaseLawJurisdiction;
  caseNumber: string;
  citationKey: string;
  decisionDate: string | null;
  identifiers: { type: DecisionIdentifierType; normalizedValue: string }[];
};

type CitationSeed = {
  citing: number;
  citationKey: string | null;
  identifier: {
    type: DecisionIdentifierType;
    normalizedValue: string;
  } | null;
  status: CitationResolutionStatus;
  /** The cited decision of a `resolved` row; ignored otherwise. */
  cited: number;
};

/** Store a corpus, each decision under a source of its own. */
const storeCorpus = async (
  decisionSeeds: readonly DecisionSeed[],
  citationSeeds: readonly CitationSeed[],
): Promise<{
  decisions: StoredDecision[];
  citationIds: SafeId<"caseLawCitation">[];
}> => {
  await resetCorpus();
  const decisions = decisionSeeds.map((seed) => ({
    ...seed,
    id: createSafeId<"caseLawDecision">(),
    sourceId: createSafeId<"caseLawSource">(),
  }));
  await db.insert(caseLawSources).values(
    decisions.map(({ sourceId }, index) => ({
      id: sourceId,
      adapterKey: `arrivals-${String(index)}`,
      name: `arrivals ${String(index)}`,
    })),
  );
  await db.insert(caseLawDecisions).values(
    decisions.map(
      ({
        id,
        sourceId,
        jurisdiction,
        caseNumber,
        citationKey,
        decisionDate,
      }) => ({
        id,
        sourceId,
        court: "Court",
        country: jurisdiction,
        language: "cs",
        fulltext: "text",
        caseNumber,
        citationKey,
        decisionDate,
        slug: `arrivals-${id}`,
        languageGroupKey: `arrivals-${id}`,
      }),
    ),
  );
  const identifierRows = decisions.flatMap(({ id, identifiers }) =>
    identifiers.map(({ type, normalizedValue }) => ({
      decisionId: id,
      type,
      value: normalizedValue,
      normalizedValue,
    })),
  );
  if (identifierRows.length > 0) {
    await db.insert(caseLawDecisionIdentifiers).values(identifierRows);
  }
  const citationIds = citationSeeds.map(() =>
    createSafeId<"caseLawCitation">(),
  );
  const citationRows = citationSeeds.map((seed, index) => {
    const citing =
      decisions[seed.citing % decisions.length] ??
      fail("a citation without a citing decision");
    const cited =
      decisions[seed.cited % decisions.length] ??
      fail("a resolved citation without a target");
    const resolved = seed.status === CITATION_RESOLUTION_STATUS.RESOLVED;
    return {
      id: citationIds[index] ?? fail("missing citation id"),
      citingDecisionId: citing.id,
      citationText: `citation ${String(index)}`,
      citationKey: seed.citationKey,
      identifierType: seed.identifier?.type ?? null,
      normalizedIdentifierValue: seed.identifier?.normalizedValue ?? null,
      resolutionStatus: seed.status,
      citedDecisionId: resolved ? cited.id : null,
      resolutionAttemptedAt:
        seed.status === CITATION_RESOLUTION_STATUS.PENDING
          ? null
          : new Date("2026-11-01T10:00:00.000Z"),
    };
  });
  if (citationRows.length > 0) {
    await db.insert(caseLawCitations).values(citationRows);
  }
  return {
    decisions: decisions.map(
      ({ id, jurisdiction, decisionDate, identifiers }) => ({
        id,
        jurisdiction,
        decisionDate,
        identifiers,
      }),
    ),
    citationIds,
  };
};

const fail = (message: string): never => {
  throw new Error(message);
};

/**
 * Forget the stored key of the given citations, as rows stored before the
 * column existed: the trigger is held off for the write that clears it.
 */
const unkeyCitations = async (ids: readonly SafeId<"caseLawCitation">[]) => {
  if (ids.length === 0) {
    return;
  }
  await db.execute(
    sql.raw(
      `ALTER TABLE case_law_citations DISABLE TRIGGER ${CITATION_IDENTIFIER_MATCH_KEY_TRIGGER}`,
    ),
  );
  await db
    .update(caseLawCitations)
    .set({ identifierMatchKey: null })
    .where(inArray(caseLawCitations.id, [...ids]));
  await db.execute(
    sql.raw(
      `ALTER TABLE case_law_citations ENABLE TRIGGER ${CITATION_IDENTIFIER_MATCH_KEY_TRIGGER}`,
    ),
  );
};

const unkeyedRemain = async (): Promise<boolean> => {
  const row = executedRows(await db.execute(UNKEYED_CITATIONS_REMAIN_SQL)).at(
    0,
  );
  return isRecord(row) && row["remain"] === true;
};

/** Run the online repair's batch statement until it picks nothing. */
const runBackfill = async (batchSize: number): Promise<number> => {
  let cursor: string | null = null;
  let keyed = 0;
  for (;;) {
    // db-await-in-loop: the repair is a keyset walk, one batch after another
    const { rows } = await client.query<{
      last_id: string | null;
      picked: number;
      keyed: number;
    }>(
      citationMatchKeyBatchSql('public."case_law_citations"', {
        after: cursor !== null,
      }),
      cursor === null ? [batchSize] : [batchSize, cursor],
    );
    const batch = rows.at(0) ?? fail("the backfill batch returned no row");
    if (batch.picked === 0 || batch.last_id === null) {
      return keyed;
    }
    keyed += batch.keyed;
    cursor = batch.last_id;
  }
};

/** Every stored key, against `caseNumberMatchKey` of the row's own columns. */
const expectEveryKeyFolded = async () => {
  const rows = await db
    .select({
      key: caseLawCitations.identifierMatchKey,
      value: caseLawCitations.normalizedIdentifierValue,
      citationKey: caseLawCitations.citationKey,
    })
    .from(caseLawCitations);
  for (const { key, value, citationKey } of rows) {
    const effective = value ?? citationKey;
    expect(key).toBe(effective === null ? null : caseNumberMatchKey(effective));
  }
};

// ---------------------------------------------------------------------------
// Generated corpora: few cases, printed with a four- or two-digit year, held
// by several decisions across jurisdictions, so keys collide, fold together
// and reach across borders.

const JURISDICTIONS = ["CZE", "SVK", "EU"] as const;
const DATES = [null, "2001-03-01", "2012-06-15", "2018-01-01", "2023-09-30"];

const caseArbitrary: fc.Arbitrary<CaseShape> = fc.record({
  senate: fc.integer({ min: 1, max: 9 }),
  register: fc.constantFrom("cdo", "as", "tdo", "obdo"),
  number: fc.integer({ min: 1, max: 4 }),
  year: fc.integer({ min: 1996, max: 2026 }),
  sheet: fc.constantFrom("", "", "-33"),
});

type CaseShape = {
  senate: number;
  register: string;
  number: number;
  year: number;
  sheet: string;
};

const printed = (
  { senate, register, number, year, sheet }: CaseShape,
  twoDigit: boolean,
) =>
  `${String(senate)}${register}/${String(number)}/${
    twoDigit ? String(year % 100).padStart(2, "0") : String(year)
  }${sheet}`;

const ecliOf = (caseShape: CaseShape) =>
  `ecli:cz:ns:${String(caseShape.year)}:${String(caseShape.senate)}.${caseShape.register}.${String(caseShape.number)}.${String(caseShape.year)}.1`;

const corpusArbitrary = fc.record({
  cases: fc.array(caseArbitrary, { minLength: 3, maxLength: 7 }),
  decisions: fc.array(
    fc.record({
      caseIndex: fc.nat(),
      twoDigit: fc.boolean(),
      otherForm: fc.boolean(),
      ecli: fc.boolean(),
      jurisdiction: fc.constantFrom(...JURISDICTIONS),
      date: fc.constantFrom(...DATES),
    }),
    { minLength: 4, maxLength: 10 },
  ),
  citations: fc.array(
    fc.record({
      citing: fc.nat(),
      caseIndex: fc.nat(),
      twoDigit: fc.boolean(),
      shape: fc.constantFrom(
        "legacy-key",
        "case-number",
        "case-number-other-form",
        "ecli",
        "ecli-without-key",
        "foreign",
      ),
      status: fc.constantFrom(
        CITATION_RESOLUTION_STATUS.PENDING,
        CITATION_RESOLUTION_STATUS.UNMATCHED,
        CITATION_RESOLUTION_STATUS.AMBIGUOUS,
        CITATION_RESOLUTION_STATUS.RESOLVED,
      ),
      cited: fc.nat(),
      unkeyed: fc.boolean(),
    }),
    { minLength: 20, maxLength: 80 },
  ),
  arrivalSets: fc.array(
    fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 4 }),
    {
      minLength: 2,
      maxLength: 5,
    },
  ),
});

type Corpus = typeof corpusArbitrary extends fc.Arbitrary<infer T> ? T : never;

const seedsOf = (corpus: Corpus) => {
  const caseAt = (index: number) =>
    corpus.cases[index % corpus.cases.length] ?? fail("no case");
  const decisionSeeds: DecisionSeed[] = corpus.decisions.map((decision) => {
    const caseShape = caseAt(decision.caseIndex);
    const key = printed(caseShape, decision.twoDigit);
    return {
      jurisdiction: decision.jurisdiction,
      caseNumber: key,
      citationKey: key,
      decisionDate: decision.date,
      identifiers: [
        { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, normalizedValue: key },
        ...(decision.otherForm
          ? [
              {
                type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
                normalizedValue: printed(caseShape, !decision.twoDigit),
              },
            ]
          : []),
        ...(decision.ecli
          ? [
              {
                type: DECISION_IDENTIFIER_TYPES.ECLI,
                normalizedValue: ecliOf(caseShape),
              },
            ]
          : []),
      ],
    };
  });
  const citationSeeds: CitationSeed[] = corpus.citations.map((citation) => {
    const caseShape = caseAt(citation.caseIndex);
    const key = printed(caseShape, citation.twoDigit);
    const other = printed(caseShape, !citation.twoDigit);
    const base = {
      citing: citation.citing,
      status: citation.status,
      cited: citation.cited,
    };
    switch (citation.shape) {
      case "legacy-key":
        return { ...base, citationKey: key, identifier: null };
      case "case-number":
        return {
          ...base,
          citationKey: key,
          identifier: {
            type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            normalizedValue: key,
          },
        };
      case "case-number-other-form":
        return {
          ...base,
          citationKey: key,
          identifier: {
            type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            normalizedValue: other,
          },
        };
      case "ecli":
        return {
          ...base,
          citationKey: key,
          identifier: {
            type: DECISION_IDENTIFIER_TYPES.ECLI,
            normalizedValue: ecliOf(caseShape),
          },
        };
      case "ecli-without-key":
        return {
          ...base,
          citationKey: null,
          identifier: {
            type: DECISION_IDENTIFIER_TYPES.ECLI,
            normalizedValue: ecliOf(caseShape),
          },
        };
      case "foreign":
        return {
          ...base,
          citationKey: `${key}x`,
          identifier: null,
        };
      default:
        return citation.shape satisfies never;
    }
  });
  return { decisionSeeds, citationSeeds };
};

type Tally = { compared: number; revived: number; contested: number };

/** Each arrival set reopens what the old statement reopened per decision. */
const expectEquivalent = async (
  decisions: readonly StoredDecision[],
  arrivalSets: readonly (readonly number[])[],
  label: string,
  tally: Tally,
) => {
  for (const set of arrivalSets) {
    const arriving = [
      ...new Set(set.map((index) => index % decisions.length)),
    ].map((index) => decisions[index] ?? fail("no decision"));
    // db-await-in-loop: each arrival set is compared on the same corpus
    const legacy = await legacySelection(arriving);
    // db-await-in-loop: each arrival set is compared on the same corpus
    expect(await batchedSelection(arrivalsOf(arriving)), label).toEqual(
      legacy.ids,
    );
    tally.compared++;
    tally.revived += legacy.revived;
    tally.contested += legacy.contested;
  }
  for (const decision of decisions) {
    // db-await-in-loop: the single-decision wrapper, per decision
    expect(await singleDecisionSelection(decision), label).toEqual(
      (await legacySelection([decision])).ids,
    );
  }
};

// timeout: stores and compares several generated corpora.
test(
  "a drain reopens exactly what the per-decision statement reopened, before, during and after the repair",
  async () => {
    const tally: Tally = { compared: 0, revived: 0, contested: 0 };
    const samples = drawPropertySamples(corpusArbitrary, { numRuns: 12 });
    for (const { value: corpus, label } of samples) {
      const { decisionSeeds, citationSeeds } = seedsOf(corpus);
      // db-await-in-loop: one corpus at a time, each compared three ways
      const { decisions, citationIds } = await storeCorpus(
        decisionSeeds,
        citationSeeds,
      );
      // Every row written since the column: keyed by the trigger.
      expect(await unkeyedRemain(), label).toBe(false);
      await expectEveryKeyFolded();
      await expectEquivalent(decisions, corpus.arrivalSets, label, tally);

      // The backfill window: some rows stored before the column.
      const unkeyed = citationIds.filter(
        (_, index) => corpus.citations[index]?.unkeyed === true,
      );
      await unkeyCitations(unkeyed);
      const anyUnkeyable = citationSeeds.some(
        (seed, index) =>
          corpus.citations[index]?.unkeyed === true &&
          (seed.identifier !== null || seed.citationKey !== null),
      );
      expect(await unkeyedRemain(), label).toBe(anyUnkeyable);
      await expectEquivalent(decisions, corpus.arrivalSets, label, tally);

      // After the repair: every row keyed, the folded arm left out.
      await runBackfill(7);
      expect(await unkeyedRemain(), label).toBe(false);
      await expectEveryKeyFolded();
      await expectEquivalent(decisions, corpus.arrivalSets, label, tally);
    }
    // Non-vacuity: both arms of the old statement selected rows.
    expect(tally.compared).toBeGreaterThan(0);
    expect(tally.revived).toBeGreaterThan(0);
    expect(tally.contested).toBeGreaterThan(0);
  },
  { timeout: 240_000 },
);

// ---------------------------------------------------------------------------
// Real docket shapes, as courts print them.

test("real dockets reopen alike in either year form, across the EU reach and by date", async () => {
  const seeds: DecisionSeed[] = [
    {
      jurisdiction: "CZE",
      caseNumber: "23 Cdo 1/2022",
      citationKey: "23cdo/1/2022",
      decisionDate: "2022-06-01",
      identifiers: [
        { type: "case-number", normalizedValue: "23cdo/1/2022" },
        {
          type: "ecli",
          normalizedValue: "ecli:cz:ns:2022:23.cdo.1.2022.1",
        },
      ],
    },
    {
      jurisdiction: "EU",
      caseNumber: "C-679/18",
      citationKey: "c-679/18",
      decisionDate: "2019-10-02",
      identifiers: [{ type: "case-number", normalizedValue: "c-679/18" }],
    },
    {
      jurisdiction: "SVK",
      caseNumber: "5Obdo/12/2019",
      citationKey: "5obdo/12/2019",
      decisionDate: "2020-02-27",
      identifiers: [{ type: "case-number", normalizedValue: "5obdo/12/2019" }],
    },
    {
      jurisdiction: "CZE",
      caseNumber: "8 As 287/2020-33",
      citationKey: "8as/287/2020-33",
      decisionDate: "2021-03-04",
      identifiers: [
        { type: "case-number", normalizedValue: "8as/287/2020-33" },
      ],
    },
    // A second holder of the EU key, from another court's source.
    {
      jurisdiction: "EU",
      caseNumber: "C-679/2018",
      citationKey: "c-679/2018",
      decisionDate: "2019-10-02",
      identifiers: [{ type: "case-number", normalizedValue: "c-679/2018" }],
    },
  ];
  const statuses = [
    CITATION_RESOLUTION_STATUS.UNMATCHED,
    CITATION_RESOLUTION_STATUS.AMBIGUOUS,
    CITATION_RESOLUTION_STATUS.RESOLVED,
    CITATION_RESOLUTION_STATUS.PENDING,
  ];
  const printings: CitationSeed["identifier"][] = [
    { type: "case-number", normalizedValue: "23cdo/1/22" },
    { type: "case-number", normalizedValue: "23cdo/1/2022" },
    { type: "ecli", normalizedValue: "ecli:cz:ns:2022:23.cdo.1.2022.1" },
    { type: "case-number", normalizedValue: "c-679/2018" },
    { type: "case-number", normalizedValue: "c-679/18" },
    { type: "case-number", normalizedValue: "5obdo/12/19" },
    { type: "case-number", normalizedValue: "8as/287/20-33" },
    { type: "case-number", normalizedValue: "8as/287/2020" },
    null,
  ];
  // A citation names its case by key, except one that printed only an ECLI.
  const citationKeyFor = (identifier: CitationSeed["identifier"]) => {
    if (identifier === null) {
      return "c-679/2018";
    }
    return identifier.type === "ecli" ? null : identifier.normalizedValue;
  };
  const citationSeeds: CitationSeed[] = printings.flatMap((identifier, p) =>
    seeds.flatMap((_, citing) =>
      statuses.map((status, s) => ({
        citing,
        citationKey: citationKeyFor(identifier),
        identifier,
        status,
        cited: p + s,
      })),
    ),
  );
  const { decisions, citationIds } = await storeCorpus(seeds, citationSeeds);
  const everySet = [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4], [1, 4]];
  const tally: Tally = { compared: 0, revived: 0, contested: 0 };
  await expectEquivalent(decisions, everySet, "real dockets", tally);
  expect(tally.revived).toBeGreaterThan(0);
  expect(tally.contested).toBeGreaterThan(0);
  await unkeyCitations(citationIds.filter((_, index) => index % 2 === 0));
  await expectEquivalent(
    decisions,
    everySet,
    "real dockets, half unkeyed",
    tally,
  );
  await runBackfill(5);
  await expectEveryKeyFolded();
  await expectEquivalent(decisions, everySet, "real dockets, repaired", tally);
});

// ---------------------------------------------------------------------------
// The stored key and its one owner.

const keyArbitrary = fc.oneof(
  fc
    .tuple(
      fc.stringMatching(/^[a-zà-ž0-9. /-]{1,20}$/u),
      fc.integer({ min: 1890, max: 2110 }),
      fc.constantFrom("", "-", "-1", "-33", "a", " ", "/4"),
    )
    .map(([head, year, tail]) => `${head}/${String(year)}${tail}`),
  fc
    .string({ unit: "grapheme", minLength: 1, maxLength: 24 })
    .filter((key) => !key.includes("\u0000") && key.trim() === key),
);

test("the trigger's fold is the renderer's, character for character", async () => {
  const { rows } = await client.query<{ source: string }>(
    "SELECT prosrc AS source FROM pg_proc WHERE proname = $1",
    [CITATION_IDENTIFIER_MATCH_KEY_FUNCTION],
  );
  const rendered = dialect.sqlToQuery(
    caseNumberMatchKeySql(
      sql.raw("coalesce(NEW.normalized_identifier_value, NEW.citation_key)"),
    ),
  );
  expect(rendered.params).toEqual([]);
  expect(rows.at(0)?.source).toContain(
    `NEW.identifier_match_key := ${rendered.sql};`,
  );
});

test("every write stores the key caseNumberMatchKey folds, whoever writes it", async () => {
  const { decisions } = await storeCorpus(
    [
      {
        jurisdiction: "CZE",
        caseNumber: "1 As 1/2020",
        citationKey: "1as/1/2020",
        decisionDate: null,
        identifiers: [],
      },
    ],
    [],
  );
  const citing = decisions.at(0)?.id ?? fail("no citing decision");
  const samples = drawPropertySamples(
    fc.record({
      key: keyArbitrary,
      value: fc.option(keyArbitrary, { nil: null }),
      rewrite: keyArbitrary,
    }),
    { numRuns: 200 },
  );
  const ids = samples.map(() => createSafeId<"caseLawCitation">());
  await db.insert(caseLawCitations).values(
    samples.map(({ value: { key, value } }, index) => ({
      id: ids[index] ?? fail("no id"),
      citingDecisionId: citing,
      citationText: "text",
      citationKey: key,
      identifierType:
        value === null ? null : DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      normalizedIdentifierValue: value,
      // A writer cannot choose the key: the trigger overwrites it.
      identifierMatchKey: "written by the caller",
    })),
  );
  await expectEveryKeyFolded();
  // A rewrite of the key the row falls back to re-derives the stored one.
  for (const [index, { value }] of samples.entries()) {
    // db-await-in-loop: one rewrite per sampled row
    await db
      .update(caseLawCitations)
      .set({ citationKey: value.rewrite })
      .where(eq(caseLawCitations.id, ids[index] ?? fail("no id")));
  }
  await expectEveryKeyFolded();
  // So does a write that names only the key.
  await db
    .update(caseLawCitations)
    .set({ identifierMatchKey: "set directly" })
    .where(inArray(caseLawCitations.id, ids));
  await expectEveryKeyFolded();
});

// ---------------------------------------------------------------------------
// The queue: enqueued with the write, drained once, never lost, withdrawn
// with an erased decision.

const queued = async () =>
  (
    await db
      .select({ id: caseLawCitationArrivals.id })
      .from(caseLawCitationArrivals)
  ).length;

const statusOf = async (id: SafeId<"caseLawCitation">) =>
  (
    await db
      .select({ status: caseLawCitations.resolutionStatus })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.id, id))
  ).at(0)?.status;

const queueCorpus = async () => {
  const { decisions, citationIds } = await storeCorpus(
    [
      {
        jurisdiction: "CZE",
        caseNumber: "23 Cdo 1/2021",
        citationKey: "23cdo/1/2021",
        decisionDate: "2021-01-01",
        identifiers: [],
      },
      {
        jurisdiction: "CZE",
        caseNumber: "23 Cdo 7/2019",
        citationKey: "23cdo/7/2019",
        decisionDate: "2019-01-01",
        identifiers: [{ type: "case-number", normalizedValue: "23cdo/7/2019" }],
      },
    ],
    [
      {
        citing: 0,
        citationKey: "23cdo/7/19",
        identifier: { type: "case-number", normalizedValue: "23cdo/7/19" },
        status: CITATION_RESOLUTION_STATUS.UNMATCHED,
        cited: 0,
      },
    ],
  );
  const [citing, arriving] = decisions;
  const [waiting] = citationIds;
  return {
    citing: citing ?? fail("no citing decision"),
    arriving: arriving ?? fail("no arriving decision"),
    waiting: waiting ?? fail("no waiting citation"),
  };
};

const enqueue = async (decision: StoredDecision) =>
  await runCitationGraphTransaction(
    db.transaction.bind(db),
    async (tx) =>
      await enqueueCitationArrivals(tx, {
        decisionId: decision.id,
        jurisdiction: decision.jurisdiction,
        decisionDate: decision.decisionDate,
        identifiers: decision.identifiers,
      }),
  );

test("an enqueued arrival is drained once, in the transaction that settles what it reopened", async () => {
  const { arriving, waiting } = await queueCorpus();
  expect(await enqueue(arriving)).toBe(1);
  expect(await queued()).toBe(1);
  // Enqueuing reopens nothing by itself.
  expect(await statusOf(waiting)).toBe(CITATION_RESOLUTION_STATUS.UNMATCHED);

  const drained = await drainCitationArrivals(db.transaction.bind(db));
  expect(drained).toMatchObject({ drained: 1, reopened: 1 });
  expect(await queued()).toBe(0);
  expect(await statusOf(waiting)).toBe(CITATION_RESOLUTION_STATUS.RESOLVED);
  // An empty queue is a no-op.
  expect(await drainCitationArrivals(db.transaction.bind(db))).toEqual({
    drained: 0,
    reopened: 0,
    settled: null,
  });
});

test("a drain that does not commit leaves its arrivals for the next one", async () => {
  const { arriving, waiting } = await queueCorpus();
  await enqueue(arriving);
  const failing = async <T>(
    run: (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> =>
    await db.transaction(async (tx) => {
      await run(tx);
      throw new Error("the drain's transaction fails");
    });
  const rejected = await rejectionOf(drainCitationArrivals(failing));
  expect(rejected instanceof Error ? rejected.message : rejected).toBe(
    "the drain's transaction fails",
  );
  expect(await queued()).toBe(1);
  expect(await statusOf(waiting)).toBe(CITATION_RESOLUTION_STATUS.UNMATCHED);
  expect(await drainCitationArrivals(db.transaction.bind(db))).toMatchObject({
    drained: 1,
    reopened: 1,
  });
  expect(await statusOf(waiting)).toBe(CITATION_RESOLUTION_STATUS.RESOLVED);
});

test("an erased decision's arrivals are withdrawn with it and reopen nothing", async () => {
  const { arriving, waiting } = await queueCorpus();
  await enqueue(arriving);
  await db.transaction(async (tx) => {
    await CASE_LAW_REMOVAL_STORES.case_law_decision_identifiers.erase(
      asTestRaw<Transaction>(tx),
      arriving.id,
    );
    await CASE_LAW_REMOVAL_STORES.case_law_citation_arrivals.erase(
      asTestRaw<Transaction>(tx),
      arriving.id,
    );
  });
  expect(await queued()).toBe(0);
  expect(await drainCitationArrivals(db.transaction.bind(db))).toMatchObject({
    drained: 0,
  });
  expect(await statusOf(waiting)).toBe(CITATION_RESOLUTION_STATUS.UNMATCHED);
});

test("a deleted decision takes its queued arrivals with it", async () => {
  const { arriving } = await queueCorpus();
  await enqueue(arriving);
  await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, arriving.id));
  expect(await queued()).toBe(0);
});

test("a withdrawn citation is neither revived nor counted", async () => {
  const { citing, arriving, waiting } = await queueCorpus();
  await enqueue(arriving);
  // The citing decision's erasure removes the citations it makes.
  await db.transaction(async (tx) => {
    await CASE_LAW_REMOVAL_STORES.case_law_citations.erase(
      asTestRaw<Transaction>(tx),
      citing.id,
    );
  });
  expect(await statusOf(waiting)).toBeUndefined();
  expect(await drainCitationArrivals(db.transaction.bind(db))).toMatchObject({
    drained: 1,
    reopened: 0,
  });
});

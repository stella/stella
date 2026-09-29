/**
 * A decision's citation rows are its references as the writer publishes them.
 *
 * For a decision of each enrolled jurisdiction, built by its adapter and given
 * a text that cites, the pipeline writes the decision, refreshes it unchanged,
 * then refreshes it with a changed text while a review covers one of its
 * citations. After every write the stored rows must be exactly the references
 * the planner read from that text (printed form, key, typed identifier, hints,
 * kind, section and polarity, with the review in place of the rules where one
 * applies), and each row's resolution must be the one
 * `resolveDecisionReference` gives over its holders. The unchanged refresh
 * must touch no row, and the changed one only the rows that differ.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitationReviews,
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawPolarityRules,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import type { CitationResolutionStatus } from "@/api/handlers/case-law/citation-resolution-status";
import { resolveDecisionReference } from "@/api/handlers/case-law/citations/reference-resolution";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  citationKeyOf,
  normalizeDecisionIdentifier,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { planDecisionWrite } from "@/api/handlers/case-law/ingestion/pipeline/decision-plan";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { POLARITY, RULE_SOURCE } from "@/api/handlers/case-law/polarity/consts";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  atRisFixture,
  czNsFixture,
  euEcjFixture,
  huBhgyFixture,
  plSnFixture,
  skCourtsFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { readReferenceHolders } from "@/api/tests/helpers/citation-reference-holders";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
const connect = (pglite: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client: pglite,
    relations: { ...relations, ...authRelationsPart },
  });

let db: ReturnType<typeof connect>;
let scopedDb: ScopedDb;

const corpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("a postgres-only plan must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

type Holder = {
  caseNumber: string;
  court: string;
  country: string;
  language: string;
  decisionDate: string;
  decisionType: string;
  ecli?: string;
  /** Held as a typed identifier; the legacy key bridge otherwise. */
  typed?: boolean;
};

type Scenario = {
  jurisdiction: string;
  build: () => Promise<IngestionResult>;
  holders: Holder[];
  /** The text the decision is first written and refreshed with. */
  first: string[];
  /** The text of the changed refresh. */
  changed: string[];
  /** A citation both texts carry in different sentences; a review covers it. */
  reviewed: string;
  /** Outcomes the scenario reaches, so its parity is not vacuous. */
  reaches: CitationResolutionStatus[];
};

const { RESOLVED, AMBIGUOUS, UNMATCHED } = CITATION_RESOLUTION_STATUS;

const holder = (
  caseNumber: string,
  court: string,
  fields: Partial<Holder> = {},
): Holder => ({
  caseNumber,
  court,
  country: "CZE",
  language: "cs",
  decisionDate: "2020-01-01",
  decisionType: "rozsudek",
  ...fields,
});

const eu = (caseNumber: string, language: string): Holder =>
  holder(caseNumber, "Court of Justice", {
    country: "EU",
    language,
    decisionDate: "1990-11-13",
    typed: true,
  });

const scenarios: Scenario[] = [
  {
    jurisdiction: "CZE",
    build: async () => await czNsFixture().buildDecision(),
    holders: [
      holder("21 Cdo 1234/2020", "Nejvyšší soud"),
      holder("II. ÚS 100/20", "Ústavní soud", { decisionType: "nález" }),
      holder("II. ÚS 100/20", "Ústavní soud", { decisionType: "usnesení" }),
      holder("22 Cdo 55/2019", "Nejvyšší soud"),
      holder("22 Cdo 55/2019", "Nejvyšší soud", { decisionDate: "2019-07-01" }),
      holder("24 Cdo 10/2019", "Nejvyšší soud", { decisionDate: "2019-03-03" }),
      holder("24 Cdo 10/2019", "Nejvyšší soud", { decisionDate: "2019-05-05" }),
      holder("8 As 287/2020", "Nejvyšší správní soud", {
        ecli: "ECLI:CZ:NSS:2021:8.As.287.2020.33",
      }),
      holder("8 As 287/2020", "Nejvyšší správní soud", {
        ecli: "ECLI:CZ:NSS:2021:8.As.287.2020.45",
      }),
      eu("C-106/89", "cs"),
    ],
    first: [
      "K výkladu srov. rozsudek Nejvyššího soudu ze dne 3. 2. 2020, sp. zn. 21 Cdo 1234/2020, z něhož soud vycházel.",
      "Jak uvedl Ústavní soud v nálezu sp. zn. II. ÚS 100/20, soud odkazuje na rozsudek sp. zn. 22 Cdo 55/2019.",
      "Na rozdíl od rozsudku ze dne 3. 3. 2019, sp. zn. 24 Cdo 10/2019, a od rozhodnutí č. j. 8 As 287/2020-33 nelze přisvědčit.",
      "Viz rozsudek Soudního dvora C-106/89 a rozhodnutí sp. zn. 23 Cdo 77/2018.",
      "Žalovaný podal dovolání proti rozsudku odvolacího soudu, sp. zn. 5 As 999/2021, jímž bylo rozhodnuto o odvolání.",
    ],
    changed: [
      "K výkladu srov. rozsudek Nejvyššího soudu ze dne 3. 2. 2020, sp. zn. 21 Cdo 1234/2020, z něhož soud vycházel.",
      "Jak uvedl Ústavní soud v nálezu sp. zn. II. ÚS 100/20.",
      "Viz rozsudek Soudního dvora C-106/89 a rozhodnutí sp. zn. 26 Cdo 1/2017.",
      "Na rozdíl od rozsudku ze dne 3. 3. 2019, sp. zn. 24 Cdo 10/2019, nelze přisvědčit; rozsudek sp. zn. 22 Cdo 55/2019.",
    ],
    reviewed: "sp. zn. 22 Cdo 55/2019",
    reaches: [RESOLVED, AMBIGUOUS, UNMATCHED],
  },
  {
    jurisdiction: "SVK",
    build: async () => await skCourtsFixture().buildDecision(),
    holders: [
      holder("7CoCsp 16/2021", "Krajský súd v Prešove", {
        country: "SVK",
        language: "sk",
      }),
      holder("9Csp 1/2022", "Okresný súd Prešov", {
        country: "SVK",
        language: "sk",
      }),
      holder("9Csp 1/2022", "Okresný súd Poprad", {
        country: "SVK",
        language: "sk",
      }),
      eu("C-107/89", "sk"),
    ],
    first: [
      "Pozri rozsudok Krajského súdu v Prešove sp. zn. 7CoCsp 16/2021 a rozsudok Okresného súdu sp.zn. 9Csp 1/2022.",
      "Súd odkazuje na C-107/89 a sp. zn. 6CoE 14/2007.",
    ],
    changed: [
      "Rozsudok Okresného súdu sp.zn. 9Csp 1/2022.",
      "Súd odkazuje na C-107/89 a sp. zn. 6CoE 14/2007; ďalej sp. zn. 7CoCsp 16/2021.",
    ],
    reviewed: "sp. zn. 7CoCsp 16/2021",
    reaches: [RESOLVED, AMBIGUOUS, UNMATCHED],
  },
  {
    jurisdiction: "POL",
    build: async () => await plSnFixture().buildDecision(),
    holders: [
      holder("II CSK 123/20", "Sąd Najwyższy", {
        country: "POL",
        language: "pl",
      }),
      holder("II ACa 45/20", "Sąd Apelacyjny w Warszawie", {
        country: "POL",
        language: "pl",
      }),
      holder("II ACa 45/20", "Sąd Apelacyjny w Krakowie", {
        country: "POL",
        language: "pl",
      }),
      eu("C-108/89", "pl"),
    ],
    first: [
      "Por. wyrok II CSK 123/20 oraz II ACa 45/20, a także III CZP 12/20.",
      "Zob. wyrok C-108/89.",
    ],
    changed: [
      "Por. wyrok II CSK 123/20 oraz I PZ 32/95.",
      "Zob. wyrok C-108/89 oraz II ACa 45/20.",
    ],
    reviewed: "II ACa 45/20",
    reaches: [RESOLVED, AMBIGUOUS, UNMATCHED],
  },
  {
    jurisdiction: "AUT",
    build: async () => await atRisFixture("at-courts").buildDecision(),
    holders: [
      eu("C-109/89", "de"),
      eu("C-200/19", "de"),
      holder("C-200/19", "Gerichtshof", {
        country: "EU",
        language: "de",
        decisionDate: "2020-02-01",
        decisionType: "Beschluss",
        typed: true,
      }),
    ],
    first: ["Vgl. EuGH C-109/89 und C-200/19.", "Siehe C-999/18."],
    changed: ["Vgl. EuGH C-200/19.", "Siehe C-999/18 und C-109/89."],
    reviewed: "C-109/89",
    reaches: [RESOLVED, AMBIGUOUS, UNMATCHED],
  },
  {
    jurisdiction: "EU",
    build: async () => await euEcjFixture().buildDecision(),
    holders: [
      eu("C-110/89", "en"),
      eu("T-12/19", "en"),
      holder("T-12/19", "General Court", {
        country: "EU",
        language: "en",
        decisionDate: "2019-12-13",
        typed: true,
      }),
      holder("C-55/18", "Nejvyšší soud", { typed: true }),
    ],
    first: ["See Marleasing, C-110/89, and T-12/19.", "See also C-55/18."],
    changed: ["See T-12/19.", "See also C-55/18 and C-110/89."],
    reviewed: "C-110/89",
    reaches: [RESOLVED, AMBIGUOUS, UNMATCHED],
  },
  {
    jurisdiction: "HUN",
    build: async () => await huBhgyFixture().buildDecision(),
    holders: [
      holder("Pfv.20626/2022/4", "Kúria", {
        country: "HUN",
        language: "hu",
        decisionType: "ítélet",
      }),
      holder("Pfv.20626/2022/4", "Kúria", {
        country: "HUN",
        language: "hu",
        decisionDate: "2022-11-01",
        decisionType: "végzés",
      }),
      holder("Mfv.10043/2022/5", "Kúria", {
        country: "HUN",
        language: "hu",
        decisionType: "ítélet",
      }),
    ],
    first: [
      "A Kúria ítéletében Pfv.20626/2022/4 és Mfv.10043/2022/5 kifejtette.",
      "Lásd Pfv.V.20.675/2022/2.",
    ],
    changed: [
      "Lásd Pfv.V.20.675/2022/2 és Mfv.10043/2022/5.",
      "A Kúria végzésében Pfv.20626/2022/4 kifejtette.",
    ],
    reviewed: "Pfv.20626/2022/4",
    reaches: [RESOLVED, UNMATCHED],
  },
];

/** The decision with only the given paragraphs for text, and nothing to store raw. */
const withText = (
  base: IngestionResult,
  paragraphs: readonly string[],
  rawHash: string,
): IngestionResult => ({
  ...base,
  decisionDate: "2026-05-28",
  sourceRaw: undefined,
  sourceRawBytes: undefined,
  sourceRawObjects: undefined,
  sourceRawContentType: undefined,
  rawHash,
  fulltext: paragraphs.join("\n\n"),
  sections: paragraphs.map((text, index) => ({
    index,
    type: "argumentation",
    title: null,
    text,
  })),
  documentAst: EMPTY_AST,
});

let order = 0n;
const ingest = async (
  sourceId: SafeId<"caseLawSource">,
  input: IngestionResult,
): Promise<void> => {
  order += 1n;
  const outcome = await processDecision({
    input,
    observationOrder: order,
    sourceId,
    scopedDb,
    observedAt: new Date(Date.UTC(2026, 8, 26, 12, 0, Number(order))),
    refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
    corpus,
  });
  expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
};

const seedHolders = async (holders: readonly Holder[]): Promise<void> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `references-holders-${sourceId}`,
    name: "cited decisions",
  });
  for (const cited of holders) {
    const id = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      id,
      sourceId,
      sourceDocumentId: id,
      slug: id,
      caseNumber: cited.caseNumber,
      citationKey:
        cited.typed === true ? null : citationKeyOf(cited.caseNumber),
      court: cited.court,
      country: cited.country,
      language: cited.language,
      decisionDate: cited.decisionDate,
      decisionType: cited.decisionType,
      ecli: cited.ecli ?? null,
      languageGroupKey: id,
      fulltext: "text",
    });
    if (cited.typed === true) {
      const identifier = {
        type: "case-number",
        value: cited.caseNumber,
      } as const;
      await db.insert(caseLawDecisionIdentifiers).values({
        decisionId: id,
        ...identifier,
        normalizedValue: normalizeDecisionIdentifier(identifier),
      });
    }
  }
};

/** The columns the document, the rules and the reviews decide. */
const contentOf = (row: {
  citationText: string;
  citationKey: string | null;
  identifierType: DecisionIdentifierType | null;
  normalizedIdentifierValue: string | null;
  citedDecisionTypeHint: string | null;
  citedCourtHint: string | null;
  citedSheetNumber: string | null;
  citedDecisionDate: string | null;
  kind: string;
  sectionIndex: number | null;
  polarity: string | null;
  polarityRuleId: string | null;
}): string => JSON.stringify(Object.values(row));

/**
 * The rows the planner's references are published as: the stored columns in
 * one fixed order, with a review's polarity in place of the rules' where one
 * covers the key.
 */
const plannedContent = async (
  input: IngestionResult,
  citingDecisionId: SafeId<"caseLawDecision">,
  sourceId: SafeId<"caseLawSource">,
  reviews: ReadonlyMap<string, string>,
): Promise<string[]> => {
  const plan = await planDecisionWrite({
    result: input,
    existing: undefined,
    decisionId: citingDecisionId,
    sourceId,
    scopedDb,
    corpus,
    incomingCarriesDocument: true,
    polarityRules: undefined,
  });
  expect(plan.citations.citingDecisionId).toBe(citingDecisionId);
  return plan.citations.references
    .map(({ reference, verdict }) => {
      const [identifier] = reference.identifiers;
      const review =
        reference.citationKey === null
          ? undefined
          : reviews.get(reference.citationKey);
      return contentOf({
        citationText: reference.printed,
        citationKey: reference.citationKey,
        identifierType: identifier.type,
        normalizedIdentifierValue: identifier.normalizedValue,
        citedDecisionTypeHint: reference.hints.decisionType,
        citedCourtHint: reference.hints.court,
        citedSheetNumber: reference.hints.sheetNumber,
        citedDecisionDate: reference.hints.decisionDate,
        kind: reference.kind,
        sectionIndex: reference.sectionIndex,
        polarity: review ?? verdict?.polarity ?? null,
        polarityRuleId: review === undefined ? (verdict?.ruleId ?? null) : null,
      });
    })
    .toSorted();
};

const storedRows = async (citingDecisionId: SafeId<"caseLawDecision">) =>
  await db
    .select()
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citingDecisionId, citingDecisionId));

type StoredRow = Awaited<ReturnType<typeof storedRows>>[number];

const storedContent = (rows: readonly StoredRow[]): string[] =>
  rows
    .map((row) =>
      contentOf({
        citationText: row.citationText,
        citationKey: row.citationKey,
        identifierType: row.identifierType,
        normalizedIdentifierValue: row.normalizedIdentifierValue,
        citedDecisionTypeHint: row.citedDecisionTypeHint,
        citedCourtHint: row.citedCourtHint,
        citedSheetNumber: row.citedSheetNumber,
        citedDecisionDate: row.citedDecisionDate,
        kind: row.kind,
        sectionIndex: row.sectionIndex,
        polarity: row.polarity,
        polarityRuleId: row.polarityRuleId,
      }),
    )
    .toSorted();

/** Each row's resolution against what its holders make of it. */
const expectResolutionsAgree = async (
  citingDecisionId: SafeId<"caseLawDecision">,
  rows: readonly StoredRow[],
): Promise<void> => {
  const [citing] = await db
    .select({
      country: caseLawDecisions.country,
      decisionDate: caseLawDecisions.decisionDate,
      language: caseLawDecisions.language,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, citingDecisionId));
  if (citing === undefined) {
    throw new TypeError("expected the citing decision");
  }
  for (const row of rows) {
    const resolution = resolveDecisionReference({
      citing: {
        decisionId: citingDecisionId,
        jurisdiction: citing.country,
        decisionDate: citing.decisionDate,
        language: citing.language,
      },
      reference: {
        citationKey: row.citationKey,
        hints: {
          court: row.citedCourtHint,
          decisionType: row.citedDecisionTypeHint,
          sheetNumber: row.citedSheetNumber,
          decisionDate: row.citedDecisionDate,
        },
      },
      holders: await readReferenceHolders(db, {
        citationKey: row.citationKey,
        identifierType: row.identifierType,
        normalizedValue: row.normalizedIdentifierValue,
        hints: {
          court: row.citedCourtHint,
          decisionType: row.citedDecisionTypeHint,
          sheetNumber: row.citedSheetNumber,
          decisionDate: row.citedDecisionDate,
        },
      }),
    });
    expect({
      text: row.citationText,
      status: row.resolutionStatus,
      target: row.citedDecisionId,
      rule: row.resolutionRuleId,
    }).toEqual({
      text: row.citationText,
      status: resolution?.status ?? CITATION_RESOLUTION_STATUS.PENDING,
      target:
        resolution?.status === CITATION_RESOLUTION_STATUS.RESOLVED
          ? resolution.decisionId
          : null,
      rule:
        resolution?.status === CITATION_RESOLUTION_STATUS.RESOLVED
          ? resolution.rule
          : null,
    });
  }
};

/** The multiset intersection of two sorted content lists, sorted. */
const sharedContent = (
  left: readonly string[],
  right: readonly string[],
): string[] => {
  const remaining = [...right];
  return left.filter((content) => {
    const at = remaining.indexOf(content);
    if (at === -1) {
      return false;
    }
    remaining.splice(at, 1);
    return true;
  });
};

/** `xmin`/`xmax` per row: an unchanged pair is a row nobody wrote. */
const tupleHeaders = async (
  citingDecisionId: SafeId<"caseLawDecision">,
): Promise<unknown[]> =>
  (
    await db.execute(sql`
      SELECT id::text AS id, xmin::text AS xmin, xmax::text AS xmax
        FROM ${caseLawCitations}
       WHERE citing_decision_id = ${citingDecisionId}::uuid
       ORDER BY id
    `)
  ).rows;

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  // The shipped rules where there are any, and one cue per other language so
  // every scenario publishes a polarity the review then overrides.
  await db.insert(caseLawPolarityRules).values([
    ...SEED_RULES.map((seed) => ({
      pattern: seed.pattern,
      polarity: seed.polarity,
      language: seed.language,
      source: RULE_SOURCE.MANUAL,
    })),
    ...[
      { pattern: "por\\.|zob\\.", language: "pl" },
      { pattern: "vgl\\.|siehe", language: "de" },
      { pattern: "\\bsee\\b", language: "en" },
      { pattern: "lásd|ítéletében|végzésében", language: "hu" },
    ].map(({ pattern, language }) => ({
      pattern,
      language,
      polarity: POLARITY.NEUTRAL,
      source: RULE_SOURCE.MANUAL,
    })),
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const expectRowsFollowReferences = async (
  scenario: Scenario,
): Promise<void> => {
  const fetchBefore = globalThis.fetch;
  const base = await scenario.build().finally(() => {
    globalThis.fetch = fetchBefore;
  });
  expect(base.country).toBe(scenario.jurisdiction);
  await seedHolders(scenario.holders);
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `references-${scenario.jurisdiction}`,
    name: `references ${scenario.jurisdiction}`,
  });

  const first = withText(base, scenario.first, "first");
  await ingest(sourceId, first);
  const [citing] = await db
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  if (citing === undefined) {
    throw new TypeError("expected the citing decision to be written");
  }
  const citingId = brandPersistedCaseLawDecisionId(citing.id);

  const firstRows = await storedRows(citingId);
  const firstPlanned = await plannedContent(
    first,
    citingId,
    sourceId,
    new Map(),
  );
  expect(storedContent(firstRows)).toEqual(firstPlanned);
  await expectResolutionsAgree(citingId, firstRows);
  // Not vacuous: the text reaches the outcomes the scenario names, and both
  // kinds of reference where it names a procedural one.
  expect(new Set(firstRows.map((row) => row.resolutionStatus))).toEqual(
    new Set(scenario.reaches),
  );

  // The same document on a moved page: not one row is written.
  const headers = await tupleHeaders(citingId);
  await ingest(sourceId, withText(base, scenario.first, "first-moved"));
  expect(await tupleHeaders(citingId)).toEqual(headers);

  // A review covers a citation whose sentence the change moves, so its row
  // is written again and must carry the review rather than the rules.
  const reviewKey = citationKeyOf(scenario.reviewed);
  if (reviewKey === null) {
    throw new TypeError("expected the reviewed citation to have a key");
  }
  await db.insert(caseLawCitationReviews).values({
    citingDecisionId: citingId,
    citationKey: reviewKey,
    polarity: POLARITY.NEGATIVE,
    reviewRef: "references-test",
  });
  const changed = withText(base, scenario.changed, "changed");
  await ingest(sourceId, changed);
  const changedRows = await storedRows(citingId);
  const changedPlanned = await plannedContent(
    changed,
    citingId,
    sourceId,
    new Map([[reviewKey, POLARITY.NEGATIVE]]),
  );
  expect(storedContent(changedRows)).toEqual(changedPlanned);
  await expectResolutionsAgree(citingId, changedRows);

  const reviewed = changedRows.filter((row) => row.citationKey === reviewKey);
  expect(
    reviewed.map(({ polarity, polarityRuleId }) => ({
      polarity,
      polarityRuleId,
    })),
  ).toEqual([{ polarity: POLARITY.NEGATIVE, polarityRuleId: null }]);
  // The fault boundary: without the review the rules would have labelled
  // this row, and differently.
  const unreviewed = await plannedContent(
    changed,
    citingId,
    sourceId,
    new Map(),
  );
  expect(unreviewed).not.toEqual(changedPlanned);

  // Exactly the rows whose content both texts share survive, by id.
  const shared = sharedContent(firstPlanned, changedPlanned);
  expect(shared.length).toBeGreaterThan(0);
  const firstIds = new Set(firstRows.map((row) => row.id));
  const kept = changedRows.filter((row) => firstIds.has(row.id));
  expect(storedContent(kept)).toEqual(shared);
};

for (const scenario of scenarios) {
  test(`${scenario.jurisdiction}: rows are the references, refreshed only where they differ`, async () => {
    await expectRowsFollowReferences(scenario);
  }, 120_000);
}

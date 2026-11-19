import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import { resolveDecisionIdentity } from "@stll/api-contract/decision-query-intent";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { lookupDecisionsByIdentity } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import {
  citationKeyOf,
  normalizeDecisionIdentifierValueIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { admitLawRead } from "@/api/handlers/legal-resolve/admission";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { LIMITS } from "@/api/lib/limits";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const displayOnlySourceId = createSafeId<"caseLawSource">();
const displayOnlyId = createSafeId<"caseLawDecision">();
const supremeId = createSafeId<"caseLawDecision">();
const administrativeId = createSafeId<"caseLawDecision">();
const listingOnlyId = createSafeId<"caseLawDecision">();
const restrictedId = createSafeId<"caseLawDecision">();
const reportedId = createSafeId<"caseLawDecision">();
const plenaryId = createSafeId<"caseLawDecision">();
/** As the Constitutional Court publishes it: the ordinal's `Pl` is mixed case. */
const plenaryEcli = "ECLI:CZ:US:2025:Pl.US.32.25.1";
const euSourceId = createSafeId<"caseLawSource">();
const euEcli = "ECLI:EU:C:2019:801";
const euVersions = [
  { id: createSafeId<"caseLawDecision">(), language: "en" },
  { id: createSafeId<"caseLawDecision">(), language: "fr" },
] as const;
/**
 * Versions created, and so ordered by id, alphabetically: the order a crawl
 * of all 24 languages writes them in, which put Bulgarian first.
 */
const translatedVersions = (ecli: string, languages: readonly string[]) =>
  languages.map((language) => ({
    id: createSafeId<"caseLawDecision">(),
    ecli,
    language,
  }));
const unstatedLanguageVersions = translatedVersions("ECLI:EU:C:2020:559", [
  "bg",
  "cs",
  "en",
]);
const statedLanguageVersions = translatedVersions("ECLI:EU:C:2005:709", [
  "bg",
  "de",
  "en",
]);

/** A bare docket's locator: the case file, nothing singling a decision out. */
const docketLocator = (value: string) =>
  ({
    kind: "docket",
    value,
    family: value,
    selector: { kind: "none" },
  }) as const;

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
const queryLog: string[] = [];

/** A row as ingestion writes it for a decision of `jurisdiction`. */
const identifierRow = ({
  decisionId,
  jurisdiction = "CZE",
  type,
  value,
}: {
  decisionId: (typeof caseLawDecisionIdentifiers.$inferInsert)["decisionId"];
  jurisdiction?: string;
  type: DecisionIdentifierType;
  value: string;
}) => ({
  decisionId,
  type,
  value,
  normalizedValue: normalizeDecisionIdentifierValueIn(
    jurisdiction,
    type,
    value,
  ),
});

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({
      client,
      logger: {
        logQuery: (query) => {
          queryLog.push(query);
        },
      },
    });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        id: euSourceId,
        name: "EU identity fixture",
      }),
      caseLawSourceRow({
        adapterKey: "closed",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: "Publisher",
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
      caseLawSourceRow({
        adapterKey: "display-only",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: true,
          attribution: "Publisher",
          license: "permitted-redistribution",
        },
        id: displayOnlySourceId,
        name: "display only",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        id: displayOnlyId,
        sourceId: displayOnlySourceId,
        caseNumber: "4 Tdo 7/2021",
        citationKey: citationKeyOf("4 Tdo 7/2021"),
        court: "Nejvyšší soud",
        country: "CZE",
        decisionDate: "2021-02-03",
        ecli: null,
        language: "cs",
        languageGroupKey: "lookup-display-only",
        slug: "4-tdo-7-2021",
        metadata: { keywords: ["podvod", "škoda"] },
      },
      {
        id: supremeId,
        sourceId: openSourceId,
        caseNumber: "23 Cdo 1572/2012",
        citationKey: citationKeyOf("23 Cdo 1572/2012"),
        court: "Nejvyšší soud",
        country: "CZE",
        decisionDate: "2012-05-01",
        ecli: "ECLI:CZ:NS:2012:23.CDO.1572.2012.1",
        language: "cs",
        languageGroupKey: "lookup-supreme",
        slug: "23-cdo-1572-2012",
        metadata: { keywords: ["nájem", "smlouva"] },
      },
      {
        id: administrativeId,
        sourceId: openSourceId,
        caseNumber: "8 As 1/2019",
        citationKey: citationKeyOf("8 As 1/2019"),
        court: "Nejvyšší správní soud",
        country: "CZE",
        decisionDate: "2019-03-02",
        // The publisher gave the ECLI in the parallel identifiers only.
        ecli: null,
        language: "cs",
        languageGroupKey: "lookup-administrative",
        slug: "8-as-1-2019",
        metadata: {
          keywords: [`${"x".repeat(450)}\nSecond line`],
          senate: "rozšířený senát",
        },
      },
      {
        id: listingOnlyId,
        sourceId: openSourceId,
        caseNumber: "1 Afs 1/2020",
        citationKey: citationKeyOf("1 Afs 1/2020"),
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "lookup-listing-only",
        metadata: {
          [PARTIAL_OBSERVATION_KEY]: {
            [PARTIAL_OBSERVATION_FIELD.CASE_NUMBER_IS_PLACEHOLDER]: false,
            [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
          },
        },
      },
      {
        id: restrictedId,
        sourceId: closedSourceId,
        caseNumber: "3 Tdo 3/2021",
        citationKey: citationKeyOf("3 Tdo 3/2021"),
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "lookup-restricted",
      },
      {
        // Its ECLI is held in the column alone, with no identifier row.
        id: plenaryId,
        sourceId: openSourceId,
        caseNumber: "Pl.ÚS 32/25",
        citationKey: citationKeyOf("Pl.ÚS 32/25"),
        court: "Ústavní soud",
        country: "CZE",
        decisionDate: "2025-12-10",
        ecli: plenaryEcli,
        language: "cs",
        languageGroupKey: "lookup-plenary",
        slug: "pl-us-32-25",
      },
      {
        id: reportedId,
        sourceId: openSourceId,
        caseNumber: "1",
        citationKey: citationKeyOf("1"),
        court: "Supreme Court of the United States",
        courtId: "scotus",
        country: "USA",
        decisionDate: "1954-05-17",
        language: "cs",
        languageGroupKey: "lookup-reported",
      },
    ]);
    await db.insert(caseLawDecisions).values(
      euVersions.map(
        ({ id, language }) =>
          ({
            id,
            sourceId: euSourceId,
            caseNumber: "C-40/17",
            citationKey: citationKeyOf("C-40/17"),
            court: "Court of Justice of the European Union",
            country: "EU",
            decisionDate: "2019-10-03",
            ecli: euEcli,
            language,
            languageGroupKey: "lookup-eu-judgment",
          }) satisfies typeof caseLawDecisions.$inferInsert,
      ),
    );
    await db.insert(caseLawDecisions).values(
      [
        ...unstatedLanguageVersions.map((version) => ({
          ...version,
          caseNumber: "C-311/18",
          metadata: {},
        })),
        // The notice states the language of the case as an authority code.
        ...statedLanguageVersions.map((version) => ({
          ...version,
          caseNumber: "C-144/04",
          metadata: {
            procedureLanguage: [{ code: "DEU", label: "German" }],
          },
        })),
      ].map(
        ({ caseNumber, ecli, id, language, metadata }) =>
          ({
            id,
            sourceId: euSourceId,
            caseNumber,
            citationKey: citationKeyOf(caseNumber),
            court: "Court of Justice",
            country: "EU",
            decisionDate: "2020-07-16",
            ecli,
            language,
            languageGroupKey: ecli,
            metadata,
          }) satisfies typeof caseLawDecisions.$inferInsert,
      ),
    );
    await db.insert(caseLawDecisionIdentifiers).values([
      // Two parallel references on one decision: a joined case's docket and
      // the reporter citation the publisher prints beside it.
      identifierRow({
        decisionId: supremeId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "30 Cdo 400/2012",
      }),
      identifierRow({
        decisionId: supremeId,
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "Rc 55/2013",
      }),
      identifierRow({
        decisionId: administrativeId,
        type: DECISION_IDENTIFIER_TYPES.ECLI,
        value: "ECLI:CZ:NSS:2019:8.AS.1.2019",
      }),
      identifierRow({
        decisionId: listingOnlyId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "2 Afs 2/2020",
      }),
      identifierRow({
        decisionId: restrictedId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "4 Tdo 4/2021",
      }),
      // Reporter citations as a publisher spaced and abbreviated them, and a
      // neutral citation.
      identifierRow({
        decisionId: reportedId,
        jurisdiction: "USA",
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "347 U. S. 483",
      }),
      identifierRow({
        decisionId: reportedId,
        jurisdiction: "USA",
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "98 Law. Ed. 873",
      }),
      identifierRow({
        decisionId: reportedId,
        jurisdiction: "USA",
        type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
        value: "[1954] SC 7",
      }),
      // A reporter-type identifier of another jurisdiction keeps its own key.
      identifierRow({
        decisionId: administrativeId,
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "10 Atl. 5",
      }),
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test("a docket stored only as a parallel identifier resolves to its decision", async () => {
  // The reference a brief carries need not be the docket the corpus keyed the
  // row by: a joined case is cited under either number, and only one of them
  // is in `citation_key`.
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("30 Cdo 400/2012"),
  });

  expect(rows.map(({ id }) => id)).toEqual([supremeId]);
  // The parallel references travel with the row, so the caller's exact-identity
  // filter sees every name the decision answers to.
  expect(
    rows
      .at(0)
      ?.identifiers.map(({ value }) => value)
      .toSorted(),
  ).toEqual(["30 Cdo 400/2012", "Rc 55/2013"]);
});

test("an ECLI held only in the identifier rows resolves", async () => {
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "ecli", value: "ecli:cz:nss:2019:8.as.1.2019" },
  });

  expect(rows.map(({ id }) => id)).toEqual([administrativeId]);
  expect(rows.at(0)?.senate).toBe("rozšířený senát");
});

test("an ECLI held only in the column resolves in any letter case", async () => {
  for (const value of [
    plenaryEcli,
    plenaryEcli.toUpperCase(),
    plenaryEcli.toLowerCase(),
  ]) {
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: { kind: "ecli", value },
    });
    expect(
      rows.map(({ id }) => id),
      value,
    ).toEqual([plenaryId]);
  }
});

test("a decision with several parallel identifiers is one candidate", async () => {
  // Matched by its own citation key while carrying two identifier rows: a
  // one-to-many join would report it two or three times and read as ambiguous.
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("23 Cdo 1572/2012"),
  });

  expect(rows.map(({ id }) => id)).toEqual([supremeId]);
});

test("lookup draws the corpus court presentation independently of docket spelling", async () => {
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("23 Cdo 1572/2012"),
  });
  expect(
    rows.map(({ court, courtAbbreviation }) => ({ court, courtAbbreviation })),
  ).toEqual([{ court: "Nejvyšší soud", courtAbbreviation: "NS" }]);
});

test("the publication and redistribution gates apply to an identifier match", async () => {
  const listingOnly = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("2 Afs 2/2020"),
  });
  expect(listingOnly).toEqual([]);

  const restricted = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("4 Tdo 4/2021"),
  });
  expect(restricted).toEqual([]);

  // The same reference in another jurisdiction is another decision's.
  const elsewhere = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "SVK",
    locator: docketLocator("30 Cdo 400/2012"),
  });
  expect(elsewhere).toEqual([]);
});

test("a reporter citation resolves however the query spaces or abbreviates it, pin and all", async () => {
  for (const value of [
    "347 U.S. 483",
    "347 U. S. 483, 495",
    "98 L. Ed. 873",
    "98 L.Ed. 873, at 880",
    "347 u.s. 483",
    "347 U.S. 483, 495, 497",
    "347 U.S. 483 at 495",
  ]) {
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "USA",
      locator: { kind: "reporter", value },
    });
    expect(rows.map(({ id }) => id)).toEqual([reportedId]);
  }

  // The first page is identity; the next page is another decision.
  const neighbour = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "reporter", value: "347 U.S. 484" },
  });
  expect(neighbour).toEqual([]);
});

test("a reporter-type identifier elsewhere keeps the key it always had", async () => {
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "reporter", value: "Rc 55/2013" },
  });
  expect(rows.map(({ id }) => id)).toEqual([supremeId]);

  // Read as written there: not rewritten into another jurisdiction's edition.
  const asWritten = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "reporter", value: "10 Atl. 5" },
  });
  expect(asWritten.map(({ id }) => id)).toEqual([administrativeId]);
  const asCanonicalEdition = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: { kind: "reporter", value: "10 A. 5" },
  });
  expect(asCanonicalEdition).toEqual([]);
});

test("a typed reference resolves only through identifiers of its own type", async () => {
  const neutral = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "neutral", value: "[1954] sc 7" },
  });
  expect(neutral.map(({ id }) => id)).toEqual([reportedId]);
  expect(
    neutral
      .at(0)
      ?.identifiers.map(({ type }) => type)
      .toSorted(),
  ).toEqual([
    DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  ]);

  const neutralAsReporter = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: { kind: "reporter", value: "[1954] SC 7" },
  });
  expect(neutralAsReporter).toEqual([]);

  const reporterAsDocket = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "USA",
    locator: docketLocator("347 U.S. 483"),
  });
  expect(reporterAsDocket).toEqual([]);
});

test.each([
  {
    name: "in English when its own language is not stated",
    versions: unstatedLanguageVersions,
    expected: "en",
  },
  {
    name: "in the language of the case when the source states it",
    versions: statedLanguageVersions,
    expected: "de",
  },
])("an EU decision resolves $name", async ({ versions, expected }) => {
  const ecli = versions[0]?.ecli ?? panic("Fixture group is empty");
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "EU",
    locator: { kind: "ecli", value: ecli },
  });
  // The fixture is ordered so the first-sorting version is not the answer.
  expect(versions[0]?.language).not.toBe(expected);
  expect(rows.map(({ language }) => language)).toEqual([expected]);
  expect(rows[0]?.languageAlternates.map(({ language }) => language)).toEqual(
    versions.map(({ language }) => language),
  );
});

test("EU ECLI resolution returns one decision with its stored language versions", async () => {
  const admitted = admitLawRead({
    organizationId: mintAuthProviderId<"organization">(),
    publicLawEnabled: () => true,
  });
  if (Result.isError(admitted)) {
    panic("Fixture law read was not admitted");
  }
  const rows = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "EU",
    locator: { kind: "ecli", value: euEcli },
  });
  expect(rows).toHaveLength(1);
  const result = await resolveDecision({
    admission: admitted.value,
    country: "EU",
    identifier: euEcli,
    dependencies: {
      lookup: async ({ country, countries, locator }) =>
        await lookupDecisionsByIdentity({
          caseLawDb,
          country,
          countries:
            countries ?? panic("Decision resolution omitted its country gate"),
          locator,
        }),
      read: async (options) =>
        await readDecisionReaderSource({ ...options, caseLawDb }),
    },
  });
  if (result.status !== "resolved" || result.document.kind !== "decision") {
    panic("EU ECLI did not resolve to one decision");
  }
  expect(result.document.ecli).toBe(euEcli);
  expect(result.document.country).toBe("EU");
  const { decisionId } = result.document;
  const selectedVersion =
    euVersions.find(({ id }) => id === decisionId) ??
    panic("EU resolution returned a decision outside its language group");
  expect(result.document.language).toBe(selectedVersion.language);
  expect(result.document.languageAlternates).toEqual(
    euVersions.map(({ id, language }) => ({
      decisionId: String(id),
      language,
    })),
  );
});

test.each(
  euVersions.flatMap((version) =>
    (["pages", "search"] as const).map((surface) => ({ version, surface })),
  ),
)(
  "stored EU $version.language opens on the $surface surface",
  async ({ surface, version }) => {
    for (const reading of ["identity", surface] as const) {
      expect(
        await withRedistributableSubject(
          caseLawDb,
          reading,
          { kind: "id", id: version.id },
          async ({ id }) => id,
        ),
      ).toBe(version.id);
    }
  },
);

test("identity candidates carry bounded first-line publisher classifications", async () => {
  const supreme = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("23 Cdo 1572/2012"),
  });
  expect(supreme.at(0)?.subjectSummary).toBe("nájem · smlouva");
  const administrative = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("8 As 1/2019"),
  });
  expect(administrative.at(0)?.subjectSummary).toBe("x".repeat(400));
});

test("a source that withholds derived AI resolves without its publisher classification", async () => {
  const displayOnly = await lookupDecisionsByIdentity({
    caseLawDb,
    country: "CZE",
    locator: docketLocator("4 Tdo 7/2021"),
  });
  expect(displayOnly.map(({ id }) => id)).toEqual([displayOnlyId]);
  expect(displayOnly.at(0)?.subjectSummary).toBeNull();
});

test("identity response work stays fixed as unrelated corpus rows grow from 10 to 200", async () => {
  const db = drizzle({ client });
  const addUnrelated = async (start: number, end: number) => {
    await db.insert(caseLawDecisions).values(
      Array.from({ length: end - start }, (_, index) => ({
        id: createSafeId<"caseLawDecision">(),
        sourceId: openSourceId,
        caseNumber: `91 A ${String(start + index + 1)}/2025`,
        citationKey: citationKeyOf(`91 A ${String(start + index + 1)}/2025`),
        court: "Krajský soud v Praze",
        country: "CZE",
        language: "cs",
        languageGroupKey: `lookup-growth-${String(start + index)}`,
      })),
    );
  };
  const measure = async () => {
    queryLog.length = 0;
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator("8 As 1/2019"),
    });
    return {
      statements: queryLog.length,
      bytes: new TextEncoder().encode(JSON.stringify(rows)).byteLength,
      rows: rows.length,
    };
  };
  await addUnrelated(0, 10);
  const small = await measure();
  await addUnrelated(10, 200);
  const large = await measure();
  expect(small.statements).toBeGreaterThan(0);
  expect(small.rows).toBe(1);
  expect(large).toEqual(small);
});

const storedKindExamples = {
  [DECISION_IDENTIFIER_TYPES.AUTHORITY_DECISION_NUMBER]: {
    country: "CZE",
    value: "ÚOHS-S0236/2016/KD-17418/2016/851/LŠt",
  },
  [DECISION_IDENTIFIER_TYPES.CASE_NUMBER]: {
    country: "CZE",
    value: "29 Cdo 4084/2009",
  },
  [DECISION_IDENTIFIER_TYPES.COMMISSION_CASE_NUMBER]: {
    country: "EU",
    value: "SA.12345",
  },
  [DECISION_IDENTIFIER_TYPES.ECLI]: {
    country: "CZE",
    value: "ECLI:CZ:NS:2020:29.CDO.4084.2009.1",
  },
  [DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION]: {
    country: "EU",
    value: "EU-neutral-2024-7",
  },
  [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION]: {
    country: "CZE",
    value: "Rc 60/2015",
  },
} as const satisfies Record<
  DecisionIdentifierType,
  { country: string; value: string }
>;

const resolveStoredReference = async (country: string, identifier: string) => {
  const admitted = admitLawRead({
    organizationId: mintAuthProviderId<"organization">(),
    publicLawEnabled: () => true,
  });
  if (Result.isError(admitted)) {
    return panic("Fixture law read was not admitted");
  }
  return await resolveDecision({
    admission: admitted.value,
    country,
    identifier,
    dependencies: {
      lookup: async (options) =>
        await lookupDecisionsByIdentity({ ...options, caseLawDb }),
      read: async (options) =>
        await readDecisionReaderSource({ ...options, caseLawDb }),
    },
  });
};

// timeout: embedded Postgres fixture writes and role-gated reads share the bounded database-test budget.
test.each(Object.values(DECISION_IDENTIFIER_TYPES))(
  "stored %s reaches its owner through the database resolver",
  async (type) => {
    const { country, value } = storedKindExamples[type];
    const id = createSafeId<"caseLawDecision">();
    const db = drizzle({ client });
    await db.insert(caseLawDecisions).values({
      id,
      sourceId: openSourceId,
      country,
      court: country === "CZE" ? "Nejvyšší soud" : "Fixture court",
      language: "en",
      caseNumber: `Stored owner ${id}`,
      fulltext: "Published decision text.",
    });
    await db
      .insert(caseLawDecisionIdentifiers)
      .values(
        identifierRow({ decisionId: id, jurisdiction: country, type, value }),
      );
    const result = await resolveStoredReference(country, value);
    switch (result.status) {
      case "resolved":
        expect(result.document.kind).toBe("decision");
        if (result.document.kind !== "decision") {
          panic("Expected a decision");
        }
        expect(result.document.decisionId).toBe(id);
        break;
      case "ambiguous":
        expect(
          result.candidates.map((candidate) => candidate.decisionId),
        ).toContain(id);
        break;
      case "country_unavailable":
      case "incomplete_identifier":
      case "not_found":
        return panic(
          `Stored identifier did not resolve to its owner: ${result.status}`,
        );
      default:
        result satisfies never;
        return panic("Unexpected resolution status");
    }
    return undefined;
  },
  DB_TEST_TIMEOUT_MS,
);
// timeout: embedded Postgres fixture writes and role-gated reads share the bounded database-test budget.
test(
  "a sheetless family stays qualified without an exact stored docket",
  async () => {
    const id = createSafeId<"caseLawDecision">();
    const value = "7 Afs 17/2025";
    await drizzle({ client })
      .insert(caseLawDecisions)
      .values({
        id,
        sourceId: openSourceId,
        country: "CZE",
        court: "Fixture court",
        language: "cs",
        caseNumber: `${value} - 46`,
        docketFamilyKey: docketFamilyKeyOf(value, "CZE"),
      });
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator(value),
    });
    expect(rows.map((row) => row.id)).toEqual([id]);
    const resolution = resolveDecisionIdentity(
      {
        type: "identifier",
        kind: "docket",
        value,
        family: value,
        selector: { kind: "none" },
        jurisdiction: "CZE",
      },
      rows,
      { exactIdentityRead: rows.at(0)?.exactIdentityRead },
    );
    expect(resolution.status).toBe("incomplete_identifier");
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: the bounded embedded Postgres fixture inserts the candidate-limit boundary before reading it.
test(
  "exact docket scans distinguish the candidate limit from one additional owner",
  async () => {
    const value = "28 Cdo 100/2026";
    const db = drizzle({ client });
    const owners = Array.from(
      { length: LIMITS.caseLawSearchPageSizeMax },
      () => ({ id: createSafeId<"caseLawDecision">() }),
    );
    await db.insert(caseLawDecisions).values(
      owners.map(({ id }) => ({
        id,
        sourceId: openSourceId,
        country: "CZE",
        court: "Fixture court",
        language: "cs",
        caseNumber: `Stored ${id}`,
      })),
    );
    await db.insert(caseLawDecisionIdentifiers).values(
      owners.map(({ id }) =>
        identifierRow({
          decisionId: id,
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value,
        }),
      ),
    );
    const complete = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator(value),
    });
    expect(complete).toHaveLength(LIMITS.caseLawSearchPageSizeMax);
    expect(new Set(complete.map((row) => row.exactIdentityRead))).toEqual(
      new Set(["complete"]),
    );
    expect(new Set(complete.map((row) => row.id))).toEqual(
      new Set(owners.map(({ id }) => id)),
    );

    const additionalId = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      id: additionalId,
      sourceId: openSourceId,
      country: "CZE",
      court: "ZZ last court",
      language: "cs",
      caseNumber: `Stored ${additionalId}`,
    });
    await db.insert(caseLawDecisionIdentifiers).values(
      identifierRow({
        decisionId: additionalId,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value,
      }),
    );
    const truncated = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator(value),
    });
    expect(truncated).toHaveLength(LIMITS.caseLawSearchPageSizeMax);
    expect(new Set(truncated.map((row) => row.exactIdentityRead))).toEqual(
      new Set(["truncated"]),
    );
    expect(truncated.map((row) => row.id)).not.toContain(additionalId);
    const result = await resolveStoredReference("CZE", value);
    expect(result).toMatchObject({
      status: "ambiguous",
      candidateSet: "truncated",
    });
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: the bounded embedded Postgres fixture inserts a full family before role-gated reads.
test(
  "family expansion cannot displace an exact stored owner past the read limit",
  async () => {
    const value = "8 Afs 9/2026";
    const db = drizzle({ client });
    const family = Array.from(
      { length: LIMITS.caseLawSearchPageSizeMax + 1 },
      (_, index) => ({
        id: createSafeId<"caseLawDecision">(),
        sourceId: openSourceId,
        country: "CZE",
        court: "Nejvyšší správní soud",
        decisionDate: "2000-01-01",
        language: "cs",
        caseNumber: `${value} - ${index + 1}`,
        docketFamilyKey: docketFamilyKeyOf(value, "CZE"),
      }),
    );
    await db.insert(caseLawDecisions).values(family);
    const id = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      id,
      sourceId: openSourceId,
      country: "CZE",
      court: "Nejvyšší správní soud",
      decisionDate: "2026-01-01",
      language: "cs",
      caseNumber: `Stored ${id}`,
    });
    await db.insert(caseLawDecisionIdentifiers).values(
      identifierRow({
        decisionId: id,
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value,
      }),
    );
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator(value),
    });
    expect(rows.at(0)?.id).toBe(id);
    expect(rows.at(0)?.exactIdentityRead).toBe("complete");
    const result = await resolveStoredReference("CZE", value);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") {
      panic("Expected explicit candidate ambiguity");
    }
    expect(
      result.candidates.map((candidate) => candidate.decisionId),
    ).toContain(id);
  },
  DB_TEST_TIMEOUT_MS,
);

// timeout: bounded embedded Postgres fixtures exercise indexed legacy identity paths.
test.each(
  (["citation-key", "identifier", "family-key"] as const).flatMap(
    (mode, index) => [
      { mode, ordinal: 42 + index, storedZero: true },
      { mode, ordinal: 42 + index, storedZero: false },
    ],
  ),
)(
  "Czech zero senate reads legacy $mode identities in both directions ($storedZero)",
  async ({ mode, ordinal, storedZero }) => {
    const base = `Ts ${ordinal}/2003`;
    const stored = storedZero ? `0 ${base}` : base;
    const query = storedZero ? base : `0 ${base}`;
    const printed = mode === "family-key" ? `${stored} - 46` : stored;
    const db = drizzle({ client });
    const sourceId = createSafeId<"caseLawSource">();
    await db
      .insert(caseLawSources)
      .values(
        caseLawSourceRow({ id: sourceId, adapterKey: ADAPTER_KEYS.CZ_NSS }),
      );
    const id = createSafeId<"caseLawDecision">();
    const positiveId = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values([
      {
        id,
        sourceId,
        country: "CZE",
        court: "Nejvyšší soud",
        language: "cs",
        caseNumber: printed,
        citationKey: mode === "identifier" ? null : citationKeyOf(printed),
        docketFamilyKey:
          mode === "family-key"
            ? `${storedZero ? "0" : ""}ts${ordinal}/2003`
            : null,
      },
      {
        id: positiveId,
        sourceId: openSourceId,
        country: "CZE",
        court: "Nejvyšší soud",
        language: "cs",
        caseNumber: `1 ${base}`,
        citationKey: citationKeyOf(`1 ${base}`),
        docketFamilyKey: `1ts${ordinal}/2003`,
      },
    ]);
    if (mode === "identifier") {
      await db.insert(caseLawDecisionIdentifiers).values(
        identifierRow({
          decisionId: id,
          type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          value: stored,
        }),
      );
    }
    const rows = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator(query),
    });
    expect(rows.map((row) => row.id)).toContain(id);
    expect(rows.map((row) => row.id)).not.toContain(positiveId);
    const anotherYear = await lookupDecisionsByIdentity({
      caseLawDb,
      country: "CZE",
      locator: docketLocator(query.replace("2003", "2004")),
    });
    expect(anotherYear.map((row) => row.id)).not.toContain(id);
    if (mode === "family-key") {
      const selected = await lookupDecisionsByIdentity({
        caseLawDb,
        country: "CZE",
        locator: {
          kind: "docket",
          value: `${query}-46`,
          family: query,
          selector: { kind: "sheet", value: "46" },
        },
      });
      expect(selected.map((row) => row.id)).toContain(id);
      expect(selected.map((row) => row.id)).not.toContain(positiveId);
    }
  },
  DB_TEST_TIMEOUT_MS,
);

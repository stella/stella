import type { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/decision-reporter-grammar";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  findDecisionIdsByIdentity,
  searchCorpusIndexDecisions,
  searchPostgresDecisions,
} from "@/api/handlers/case-law/decisions/search";
import {
  citationKeyOf,
  normalizeDecisionIdentifierValueIn,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexReadTarget } from "@/api/lib/legal-search/corpus-index-group-contract";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const sourceId = createSafeId<"caseLawSource">();
const plenaryId = createSafeId<"caseLawDecision">();
const supremeId = createSafeId<"caseLawDecision">();
const reportedId = createSafeId<"caseLawDecision">();
const nssReportedId = createSafeId<"caseLawDecision">();
const docketLookalikeId = createSafeId<"caseLawDecision">();
const malformedReporterId = createSafeId<"caseLawDecision">();
const tokenOnlyId = createSafeId<"caseLawDecision">();
const tokenRevision = createSafeId<"corpusIndexProjectionIntent">();
const collectionTokenText = "R 60/2014 č. 3528/2017 Sb. NSS";

/** A row as ingestion writes it for a decision of `jurisdiction`. */
const identifierRow = (
  jurisdiction: string,
  decisionId: SafeId<"caseLawDecision">,
  type: DecisionIdentifierType,
  value: string,
) => ({
  decisionId,
  type,
  value,
  normalizedValue: normalizeDecisionIdentifierValueIn(
    jurisdiction,
    type,
    value,
  ),
});

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    await client.exec(
      "CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple)",
    );
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        const adaptedTx = {
          select: roleTx.select.bind(roleTx),
          query: roleTx.query,
          execute: async (statement: Parameters<typeof roleTx.execute>[0]) => {
            const result = await roleTx.execute(statement);
            return Object.assign(result.rows, { rows: result.rows });
          },
        };
        // SAFETY: the role transaction supplies the select and SQL execution surfaces the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = adaptedTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db
      .insert(caseLawSources)
      .values([
        caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      ]);
    await db.insert(caseLawDecisions).values([
      {
        id: plenaryId,
        sourceId,
        // As the publisher prints it: no space after the abbreviation.
        caseNumber: "Pl.ÚS 24/10",
        citationKey: citationKeyOf("Pl.ÚS 24/10"),
        ecli: "ECLI:CZ:US:2011:PL.US.24.10.1",
        court: "Ústavní soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-plenary",
      },
      {
        id: supremeId,
        sourceId,
        caseNumber: "23 Cdo 1572/2012",
        citationKey: citationKeyOf("23 Cdo 1572/2012"),
        ecli: "ECLI:CZ:NS:2012:23.CDO.1572.2012.1",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-supreme",
      },
      {
        id: reportedId,
        sourceId,
        caseNumber: "1",
        citationKey: citationKeyOf("1"),
        court: "Supreme Court of the United States",
        courtId: "scotus",
        country: "USA",
        language: "cs",
        languageGroupKey: "identity-reported",
      },
    ]);
    await db.insert(caseLawDecisions).values([
      {
        id: nssReportedId,
        sourceId,
        caseNumber: "1 Afs 183/2014-55",
        citationKey: citationKeyOf("1 Afs 183/2014-55"),
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-nss-reporter",
      },
      {
        id: docketLookalikeId,
        sourceId,
        caseNumber: "R 60/2014",
        citationKey: citationKeyOf("R 60/2014"),
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-reporter-docket-lookalike",
      },
      {
        id: malformedReporterId,
        sourceId,
        caseNumber: "2 Cdo 2/2014",
        citationKey: citationKeyOf("2 Cdo 2/2014"),
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "identity-malformed-reporter",
      },
      {
        id: tokenOnlyId,
        sourceId,
        caseNumber: "1 Cdo 1/2020",
        citationKey: citationKeyOf("1 Cdo 1/2020"),
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        fulltext: collectionTokenText,
        languageGroupKey: "identity-reporter-token-only",
      },
    ]);
    await db.insert(caseLawSearchDocuments).values({
      decisionId: tokenOnlyId,
      language: "cs",
      regconfig: "simple",
      searchableText: collectionTokenText,
      tsv: sql`to_tsvector('simple', ${collectionTokenText})`,
    });
    await db.insert(caseLawDecisionIdentifiers).values([
      // NSS legacy metadata loses the diacritic on the collection marker.
      identifierRow(
        "CZE",
        nssReportedId,
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        "c. 3528/2017 Sb. NSS",
      ),
      identifierRow(
        "CZE",
        docketLookalikeId,
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        "R 60/2014",
      ),
      // Same normalized storage key, but no valid collection citation.
      identifierRow(
        "CZE",
        malformedReporterId,
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        "R 60 2014",
      ),
      identifierRow(
        "CZE",
        supremeId,
        DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        "23 Cdo 1572/2012",
      ),
      identifierRow(
        "CZE",
        supremeId,
        DECISION_IDENTIFIER_TYPES.ECLI,
        "ECLI:CZ:NS:2012:23.CDO.1572.2012.1",
      ),
      identifierRow(
        "USA",
        reportedId,
        DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        "347 U. S. Rep. 483",
      ),
      // The other spelling the plenary decision declares.
      identifierRow(
        "CZE",
        plenaryId,
        DECISION_IDENTIFIER_TYPES.ECLI,
        "ECLI:CZ:US:2011:Pl.US.24.10",
      ),
    ]);
    resetPublicCaseLawConfigForTesting(caseLawDb);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  resetPublicCaseLawConfigForTesting();
  await client.close();
});

test("a docket resolves by its citation key however the reader spaces it", async () => {
  const spaced = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: {
      type: "identifier",
      kind: "docket",
      jurisdiction: "CZE",
      value: "Pl. ÚS 24/10",
      family: "Pl. ÚS 24/10",
      selector: { kind: "none" },
    },
  });
  expect(spaced).toEqual([plenaryId]);

  const unscoped = await findDecisionIdsByIdentity({
    caseLawDb,
    country: undefined,
    identity: {
      type: "identifier",
      kind: "docket",
      jurisdiction: "CZE",
      value: "23 Cdo 1572/2012",
      family: "23 Cdo 1572/2012",
      selector: { kind: "none" },
    },
  });
  expect(unscoped).toEqual([supremeId]);
});

test("an ECLI resolves by equality regardless of the reader's case", async () => {
  const ids = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: {
      type: "identifier",
      kind: "ecli",
      value: "ecli:cz:ns:2012:23.cdo.1572.2012.1",
    },
  });
  expect(ids).toEqual([supremeId]);
});

test("an ECLI resolves by a spelling the decision declares as an identifier", async () => {
  const ids = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: {
      type: "identifier",
      kind: "ecli",
      value: "ECLI:CZ:US:2011:Pl.US.24.10",
    },
  });
  expect(ids).toEqual([plenaryId]);
});

test("an identifier nobody holds, or held in another jurisdiction, resolves to nothing", async () => {
  const unknown = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: {
      type: "identifier",
      kind: "docket",
      jurisdiction: "CZE",
      value: "22 Cdo 1/2026",
      family: "22 Cdo 1/2026",
      selector: { kind: "none" },
    },
  });
  expect(unknown).toEqual([]);

  const elsewhere = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "SVK",
    identity: {
      type: "identifier",
      kind: "docket",
      jurisdiction: "CZE",
      value: "Pl. ÚS 24/10",
      family: "Pl. ÚS 24/10",
      selector: { kind: "none" },
    },
  });
  expect(elsewhere).toEqual([]);
});

test("a docket or ECLI held in both the row and its identifiers is one hit", async () => {
  const byDocket = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: {
      type: "identifier",
      kind: "docket",
      jurisdiction: "CZE",
      value: "23 Cdo 1572/2012",
      family: "23 Cdo 1572/2012",
      selector: { kind: "none" },
    },
  });
  expect(byDocket).toEqual([supremeId]);

  const byEcli = await findDecisionIdsByIdentity({
    caseLawDb,
    country: undefined,
    identity: {
      type: "identifier",
      kind: "ecli",
      value: "ECLI:CZ:NS:2012:23.CDO.1572.2012.1",
    },
  });
  expect(byEcli).toEqual([supremeId]);
});

test("a reporter citation resolves through the typed identifiers", async () => {
  // The entry as the query box reads it, spaced differently from the row.
  const intent = parseDecisionQuery("347 U. S. 483, 495", {
    reporters: decisionReporterGrammarForJurisdiction("USA"),
  });
  if (intent.type !== "identifier") {
    throw new Error(`Read as ${intent.type}, not as an identifier`);
  }
  expect(intent.kind).toBe("reporter");

  const ids = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "USA",
    identity: intent,
  });
  expect(ids).toEqual([reportedId]);

  const elsewhere = await findDecisionIdsByIdentity({
    caseLawDb,
    country: "CZE",
    identity: intent,
  });
  expect(elsewhere).toEqual([]);
});

test("a reporter-shaped entry elsewhere stays text", () => {
  expect(
    parseDecisionQuery("347 U.S. 483", {
      reporters: decisionReporterGrammarForJurisdiction("CZE"),
    }),
  ).toEqual({
    type: "text",
    text: "347 U.S. 483",
  });
});

test("NSS collection references reach typed rows in their legacy publisher spelling", async () => {
  for (const query of ["č. 3528/2017 Sb. NSS", "c. 3528/2017 Sb. NSS"]) {
    const identity = parseDecisionQuery(query, {
      reporters: decisionReporterGrammarForJurisdiction("CZE"),
    });
    if (identity.type !== "identifier") {
      panic("Expected a recognized collection citation");
    }
    expect(
      await findDecisionIdsByIdentity({
        caseLawDb,
        country: "CZE",
        identity,
      }),
    ).toEqual([nssReportedId]);
  }
});

test("a collection identity rejects another identifier kind and malformed same-key reporter", async () => {
  expect(
    normalizeDecisionIdentifierValueIn(
      "CZE",
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      "R 60 2014",
    ),
  ).toBe(
    normalizeDecisionIdentifierValueIn(
      "CZE",
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      "R 60/2014",
    ),
  );
  const identity = parseDecisionQuery("R 60/2014", {
    reporters: decisionReporterGrammarForJurisdiction("CZE"),
  });
  if (identity.type !== "identifier") {
    panic("Expected a recognized collection citation");
  }
  expect(
    await findDecisionIdsByIdentity({
      caseLawDb,
      country: "CZE",
      identity,
    }),
  ).toEqual([]);
});

type CollectionSearchOptions = {
  provider: "postgres" | "corpus-index";
  query: string;
};

const searchCollection = async ({
  provider,
  query,
}: CollectionSearchOptions) => {
  const body = { country: "CZE", query, limit: 10 } as const;
  if (provider === "postgres") {
    return await searchPostgresDecisions(body, caseLawDb);
  }
  const manifest = CORPUS_INDEX_MANIFESTS.case_law_v7;
  const resolution = corpusIndexReadTarget({
    manifest,
    jurisdiction: "CZE",
    attestedGroups: new Set(),
    enrolledGroups: new Set(),
  });
  if (resolution.type !== "ready") {
    panic("Expected a ready Czech corpus target");
  }
  const engine = getCorpusIndexClient(manifest.cluster);
  // These transports would offer a lexical lookalike if identity fell through.
  const scoredSpy = spyOn(engine, "scoredSearch").mockImplementation(async () =>
    Result.ok({
      numHits: 1,
      hits: [
        {
          fields: {
            document_id: tokenOnlyId,
            projection_revision: tokenRevision,
          },
          score: 1,
        },
      ],
    }),
  );
  const searchSpy = spyOn(engine, "search").mockImplementation(async () =>
    Result.ok({
      numHits: 1,
      hits: [{ document_id: tokenOnlyId, projection_revision: tokenRevision }],
      snippets: [{ text: [collectionTokenText] }],
    }),
  );
  const aggregateSpy = spyOn(engine, "aggregate").mockImplementation(async () =>
    Result.ok({}),
  );
  try {
    const page = await searchCorpusIndexDecisions({
      body,
      caseLawDb,
      observer: "unobserved",
      dependencies: {
        configuredVariant: "off",
        loadCourtWeights: async () => courtWeightMapFromSeed(),
        readSourceRegistry: async () =>
          Result.ok({ excludedSourceIds: [], nameById: new Map() }),
        readServingTarget: async () =>
          Result.ok({
            ...resolution.target,
            manifest,
            serving: {
              family: "case_law",
              generation: manifest.generation,
              cluster: manifest.cluster,
            },
          }),
      },
    });
    expect(scoredSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(aggregateSpy).not.toHaveBeenCalled();
    return page;
  } finally {
    scoredSpy.mockRestore();
    searchSpy.mockRestore();
    aggregateSpy.mockRestore();
  }
};

for (const provider of ["postgres", "corpus-index"] as const) {
  test(`${provider} returns a recognized NSS identity without a text search document`, async () => {
    const page = await searchCollection({
      provider,
      query: "č. 3528/2017 Sb. NSS",
    });
    if (!("hits" in page)) {
      panic("Expected a successful collection search page");
    }
    expect(page.hits.map(({ decisionId }) => decisionId)).toEqual([
      nssReportedId,
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.warnings).toEqual([]);
    expect(page.hits.some(({ decisionId }) => decisionId === tokenOnlyId)).toBe(
      false,
    );
  });

  test(`${provider} keeps an unresolved collection citation empty despite lexical and storage-key lookalikes`, async () => {
    const page = await searchCollection({ provider, query: "R 60/2014" });
    if (!("hits" in page)) {
      panic("Expected a successful unresolved collection page");
    }
    expect(page.hits).toEqual([]);
    expect(page.total).toEqual({ type: "exact", count: 0 });
    expect(page.nextCursor).toBeNull();
    expect(page.warnings).toEqual([
      expect.objectContaining({
        code: "collection_citation_unresolved",
        message: expect.stringContaining("R 60/2014"),
        hint: expect.stringContaining("resolve_case_law_decision"),
      }),
    ]);
  });
}

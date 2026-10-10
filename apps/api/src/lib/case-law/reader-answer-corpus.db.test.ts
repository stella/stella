import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import {
  readReaderAnswerDecision,
  readReaderAnswerRelated,
} from "./reader-answer-corpus";

const ast = (decisionId: SafeId<"caseLawDecision">) =>
  ({
    version: 1,
    source: {
      system: "fixture",
      documentId: decisionId,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: "Fixture",
      ecli: null,
      court: "Court",
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        type: "paragraph",
        id: "b3",
        anchorId: "p-3",
        number: 3,
        plainText: "Civil liability damages precedent.",
        inlines: [{ type: "text", text: "Civil liability damages precedent." }],
      },
    ],
  }) satisfies DocumentAst;

const openSourceId = createSafeId<"caseLawSource">();
const withheldSourceId = createSafeId<"caseLawSource">();
const restrictedSourceId = createSafeId<"caseLawSource">();
const origin = createSafeId<"caseLawDecision">();
const cited = createSafeId<"caseLawDecision">();
const citing = createSafeId<"caseLawDecision">();
const withheld = createSafeId<"caseLawDecision">();
const restricted = createSafeId<"caseLawDecision">();
const outside = createSafeId<"caseLawDecision">();
let client: Awaited<ReturnType<typeof createTestPglite>>;
let caseLawDb: CaseLawPublicReadDb;
const statements: { query: string; params: unknown[] }[] = [];

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({
    client,
    relations: databaseRelations,
    logger: {
      logQuery: (query, params) => {
        statements.push({ query, params });
      },
    },
  });
  const readDb = async <T>(
    read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(
      db,
      async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
    );
  caseLawDb = Object.assign(readDb, caseLawPublicReadDb);
  await db.insert(caseLawSources).values([
    caseLawSourceRow({
      id: openSourceId,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      descriptor: {
        license: "public-domain",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: true,
      },
    }),
    caseLawSourceRow({
      id: withheldSourceId,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      descriptor: {
        license: "permitted-redistribution",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: false,
      },
    }),
    caseLawSourceRow({
      id: restrictedSourceId,
      adapterKey: ADAPTER_KEYS.CZ_US,
      descriptor: {
        license: "restricted",
        attribution: null,
        allowsRedistribution: false,
        allowsDerivedAi: false,
      },
    }),
  ]);
  await db.insert(caseLawDecisions).values([
    {
      id: origin,
      sourceId: openSourceId,
      country: "CZE",
      court: "Court",
      caseNumber: "origin",
      language: "cs",
      documentAst: ast(origin),
    },
    {
      id: cited,
      sourceId: openSourceId,
      country: "CZE",
      court: "Court",
      caseNumber: "cited",
      language: "cs",
      documentAst: ast(cited),
    },
    {
      id: citing,
      sourceId: openSourceId,
      country: "CZE",
      court: "Court",
      caseNumber: "citing",
      language: "cs",
      documentAst: ast(citing),
    },
    {
      id: withheld,
      sourceId: withheldSourceId,
      country: "CZE",
      court: "Court",
      caseNumber: "withheld",
      language: "cs",
      documentAst: ast(withheld),
    },
    {
      id: restricted,
      sourceId: restrictedSourceId,
      country: "CZE",
      court: "Court",
      caseNumber: "restricted",
      language: "cs",
      documentAst: ast(restricted),
    },
    {
      id: outside,
      sourceId: openSourceId,
      country: "XAA",
      court: "Court",
      caseNumber: "outside",
      language: "xx",
      documentAst: ast(outside),
    },
  ]);
  await db.insert(caseLawCitations).values([
    ...[cited, withheld, restricted, outside].map((id) => ({
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: origin,
      citedDecisionId: id,
      citationText: "Fixture precedent",
    })),
    {
      id: createSafeId<"caseLawCitation">(),
      citingDecisionId: citing,
      citedDecisionId: origin,
      citationText: "Fixture precedent",
    },
  ]);
}, 120_000);
afterAll(async () => {
  await client.close();
});

describe("reader answer tool public corpus boundary", () => {
  test("reads only admitted cited and citing paragraph anchors without shared writes or user-derived query inputs", async () => {
    const start = statements.length;
    const privateQuery = "reader-answer-private-query-sentinel";
    const result = await readReaderAnswerRelated(
      {
        decisionId: origin,
        paragraphId: "p-3",
        direction: "both",
        query: privateQuery,
      },
      { caseLawDb },
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value.map(({ decisionId }) => decisionId).toSorted()).toEqual(
      [cited, citing].toSorted(),
    );
    for (const excerpt of result.value) {
      expect(excerpt.paragraphId).toBe("p-3");
      expect(excerpt.text).toBe("Civil liability damages precedent.");
    }
    const reads = statements.slice(start);
    expect(
      reads.some(({ query }) => query.includes("case_law_citations")),
    ).toBe(true);
    expect(
      reads.some(({ query }) => query.includes("case_law_decisions")),
    ).toBe(true);
    for (const { query, params } of reads) {
      expect(query).not.toMatch(
        /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\b/iu,
      );
      expect(query).not.toContain("case_law_analysis");
      expect(query).not.toContain("case_law_stored_analysis");
      expect(JSON.stringify(params)).not.toContain(privateQuery);
      expect(query).not.toContain(privateQuery);
    }
  });

  test("withheld or restricted origin cannot expose a graph to the model", async () => {
    for (const decisionId of [withheld, restricted, outside]) {
      const start = statements.length;
      const decision = await readReaderAnswerDecision(decisionId, {
        caseLawDb,
      });
      if (decision.isErr()) {
        throw decision.error;
      }
      expect(decision.value).toBeNull();
      const related = await readReaderAnswerRelated(
        {
          decisionId,
          paragraphId: "p-3",
          direction: "both",
          query: "liability",
        },
        { caseLawDb },
      );
      if (related.isErr()) {
        throw related.error;
      }
      expect(related.value).toEqual([]);
      expect(
        statements
          .slice(start)
          .some(({ query }) => query.includes("case_law_citations")),
      ).toBe(false);
    }
  });
});

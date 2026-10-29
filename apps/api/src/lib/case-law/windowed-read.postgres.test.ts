import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { resolveAnalysisInput } from "@/api/handlers/case-law/analysis/analysis-input";
import { readGatedDecisionCitations } from "@/api/handlers/case-law/decisions/citation-passages";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { readReaderAnswerRelated } from "@/api/lib/case-law/reader-answer-corpus";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import type { CaseLawWindowProfile } from "@/api/lib/files/windowed-read-surface";
import { WINDOWED_READ_SURFACE } from "@/api/lib/files/windowed-read-surface";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { currentReadWork } from "@/api/lib/observability/request-work";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  caseLawPublishedDecisionsFixtureSql,
  caseLawUnredactedDecisionsFixtureSql,
} from "@/api/tests/helpers/case-law-publication-view-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const CITATION_TEXT = "4 Tdo 348/2023";
const PARAGRAPH_ID = "reasoning";
const SCALES = [1, 10] as const;
const STORED_VERSION = "2026-01-01T00:00:00.123456Z";

const prepareFixture = async (db: GatedTestDb, scale: number) => {
  // Native SQL, driver result metering and canonical publication predicates;
  // temporary relations keep every fixture's data on its own pool connection.
  for (const table of [
    "case_law_sources",
    "case_law_decisions",
    "case_law_citations",
    "case_law_decision_identifiers",
  ]) {
    await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} (
      LIKE public.${sql.identifier(table)} INCLUDING DEFAULTS
    )`);
  }
  await db.execute(caseLawPublishedDecisionsFixtureSql);
  await db.execute(caseLawUnredactedDecisionsFixtureSql);
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  const targetId = createSafeId<"caseLawDecision">();
  const text = `${"Court reasoning. ".repeat(1000 * scale)} ${CITATION_TEXT}`;
  const ast = {
    version: 1,
    source: {
      system: "test",
      documentId: decisionId,
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: "Window fixture",
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
        id: PARAGRAPH_ID,
        anchorId: PARAGRAPH_ID,
        plainText: text,
        inlines: [{ type: "text", text }],
      },
    ],
  } satisfies DocumentAst;
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: ADAPTER_KEYS.CZ_NS,
    name: "Window fixture",
    descriptor: {
      license: "public-domain",
      attribution: null,
      allowsRedistribution: true,
      allowsDerivedAi: true,
    },
  });
  const identity = {
    sourceId,
    country: "CZE",
    language: "cs",
    court: "Court",
    updatedAt: sql`${STORED_VERSION}::timestamptz`,
  };
  await db.insert(caseLawDecisions).values([
    {
      ...identity,
      id: decisionId,
      caseNumber: "Window fixture",
      documentAst: ast,
      sections: [{ index: 0, type: "ruling", title: null, text }],
    },
    {
      ...identity,
      id: targetId,
      caseNumber: CITATION_TEXT,
      documentAst: { ...ast, source: { ...ast.source, documentId: targetId } },
    },
  ]);
  await db.insert(caseLawCitations).values({
    citingDecisionId: decisionId,
    citedDecisionId: targetId,
    citationText: CITATION_TEXT,
    sectionIndex: 0,
  });
  const readDb = async <T>(
    read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    options?: Parameters<CaseLawPublicReadDb>[1],
  ) =>
    await db.transaction(
      async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      {
        isolationLevel:
          options?.isolation === "repeatable-read"
            ? "repeatable read"
            : "read committed",
      },
    );
  return {
    decisionId,
    targetId,
    sourceId,
    text,
    caseLawDb: asTestRaw<CaseLawPublicReadDb>(readDb),
    scopedDb: asTestRaw<ScopedDb>(readDb),
    payloadBytes: Buffer.byteLength(JSON.stringify(ast)),
  };
};

type WindowFixture = Awaited<ReturnType<typeof prepareFixture>>;

const productionReads = {
  "case-law-reader": async (fixture: WindowFixture) => {
    const read = await readDecisionReaderSource({
      caseLawDb: fixture.caseLawDb,
      decisionId: fixture.decisionId,
      phase: "blocks",
      audience: "model",
      surface: "search",
    });
    if (read?.status !== "read" || read.ast === null) {
      panic("Window fixture must reach the admitted production reader");
    }
    const paragraph = read.ast.blocks.at(0);
    expect(paragraph?.type).toBe("paragraph");
    expect(paragraph?.plainText).toBe(fixture.text);
  },
  "citation-passages": async (fixture: WindowFixture) => {
    const read = await readGatedDecisionCitations({
      caseLawDb: fixture.caseLawDb,
      decisionId: fixture.targetId,
      cursor: undefined,
      direction: "cited_by",
      limit: 1,
      surface: "search",
    });
    if (read?.type !== "page") {
      panic("Window fixture must reach the production citation page");
    }
    expect(read.page.items).toHaveLength(1);
    const passage = read.page.items.at(0)?.passage;
    expect(passage).not.toBeNull();
    expect(passage?.anchorId).toBe(PARAGRAPH_ID);
    expect(passage?.text).toContain(CITATION_TEXT);
  },
  "reader-answer": async (fixture: WindowFixture) => {
    const read = await readReaderAnswerRelated(
      {
        decisionId: fixture.decisionId,
        paragraphId: PARAGRAPH_ID,
        direction: "cited",
        query: "Court reasoning.",
      },
      { caseLawDb: fixture.caseLawDb },
    );
    if (read.isErr()) {
      panic("Window fixture must reach the production reader answer");
    }
    expect(read.value).toHaveLength(1);
    expect(read.value.at(0)?.decisionId).toBe(fixture.targetId);
    expect(read.value.at(0)?.paragraphId).toBe(PARAGRAPH_ID);
    expect(read.value.at(0)?.text).toContain("Court reasoning.");
  },
  "analysis-input": async (fixture: WindowFixture) => {
    expect(envBase.PUBLIC_LAW_DATABASE_URL).toBeUndefined();
    const read = (
      await resolveAnalysisInput({
        decisionId: fixture.decisionId,
        scopedDb: fixture.scopedDb,
      })
    ).unwrap();
    if (read.kind !== "resolved") {
      panic("Window fixture must reach the production analysis input");
    }
    expect(read.anchorIds).toContain(PARAGRAPH_ID);
    expect(read.input.userMessage).toContain(fixture.text);
  },
} satisfies Record<
  CaseLawWindowProfile,
  (fixture: WindowFixture) => Promise<void>
>;

const expectRedacted = async (profile: string, fixture: WindowFixture) => {
  switch (profile) {
    case "analysis-input":
      expect(
        (
          await resolveAnalysisInput({
            decisionId: fixture.decisionId,
            scopedDb: fixture.scopedDb,
          })
        ).unwrap().kind,
      ).toBe("decision-not-found");
      return;
    case "citation-passages":
      expect(
        await readGatedDecisionCitations({
          caseLawDb: fixture.caseLawDb,
          decisionId: fixture.targetId,
          cursor: undefined,
          direction: "cited_by",
          limit: 1,
          surface: "search",
        }),
      ).toBeNull();
      return;
    case "reader-answer": {
      const read = await readReaderAnswerRelated(
        {
          decisionId: fixture.decisionId,
          paragraphId: PARAGRAPH_ID,
          direction: "cited",
          query: "Court reasoning.",
        },
        { caseLawDb: fixture.caseLawDb },
      );
      expect(read.isOk()).toBe(true);
      if (read.isErr()) {
        panic("Redaction must not turn into a reader failure", read.error);
      }
      expect(read.value).toEqual([]);
      return;
    }
    case "case-law-reader":
      expect(
        await readDecisionReaderSource({
          caseLawDb: fixture.caseLawDb,
          decisionId: fixture.decisionId,
          phase: "blocks",
          audience: "model",
          surface: "search",
        }),
      ).toBeNull();
      return;
    default:
      panic("Unregistered native window measurement");
  }
};

const measuredRead = async (read: () => Promise<void>) =>
  await runWithQueryCounter(async (counter) => {
    await read();
    return {
      ...(currentReadWork() ??
        panic("Native window read needs its request meter")),
      statements: counter.count,
      transactionRoundTrips: counter.transactions,
    };
  });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "production case-law window budgets",
  () => {
    test("citation text follows the refreshed source policy after a payload version change", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const fixture = await prepareFixture(db, 1);
        let policyChanged = false;
        const readDb = async <T>(
          read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
          options?: Parameters<CaseLawPublicReadDb>[1],
        ) => {
          const result = await fixture.caseLawDb(read, options);
          // Change the stored version and policy after admission closes,
          // before the lazy version-qualified payload read starts.
          if (
            !policyChanged &&
            typeof result === "object" &&
            result !== null &&
            "type" in result &&
            result.type === "page" &&
            "sources" in result
          ) {
            policyChanged = true;
            await db
              .update(caseLawDecisions)
              .set({
                updatedAt: sql`${"2026-01-01T00:00:00.123457Z"}::timestamptz`,
              })
              .where(eq(caseLawDecisions.id, fixture.decisionId));
            await db
              .update(caseLawSources)
              .set({
                descriptor: {
                  license: "public-domain",
                  attribution: null,
                  allowsRedistribution: true,
                  allowsDerivedAi: false,
                },
              })
              .where(eq(caseLawSources.id, fixture.sourceId));
          }
          return result;
        };
        const caseLawDb = asTestRaw<CaseLawPublicReadDb>(readDb);
        resetPublicCaseLawConfigForTesting(caseLawDb);
        try {
          const result = await readGatedDecisionCitations({
            caseLawDb,
            decisionId: fixture.targetId,
            cursor: undefined,
            direction: "cited_by",
            limit: 1,
            surface: "search",
          });
          expect(policyChanged).toBe(true);
          if (result?.type !== "page") {
            panic("Expected the citation page");
          }
          expect(result.page.items).toHaveLength(1);
          const item = result.page.items.at(0);
          expect(item?.textWithheldReason).toBe("source_licence");
          expect(item?.citationText).toBeNull();
          expect(item?.passage).toBeNull();
        } finally {
          resetPublicCaseLawConfigForTesting();
        }
      });
    });

    test("every case-law window measures its admitted production owner", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      expect(Object.keys(productionReads).toSorted()).toEqual(
        Object.entries(WINDOWED_READ_SURFACE)
          .filter(
            ([, entry]) =>
              entry.guard === "lib/case-law/windowed-read.postgres.test.ts",
          )
          .map(([profile]) => profile)
          .toSorted(),
      );
      for (const [profile, read] of Object.entries(productionReads)) {
        const measurements = [];
        for (const scale of SCALES) {
          const measurement = await withGatedTestClients(
            databaseUrl,
            async ({ openClient }) => {
              const { db } = openClient({ max: 1 });
              const fixture = await prepareFixture(db, scale);
              resetPublicCaseLawConfigForTesting(fixture.caseLawDb);
              try {
                const cold = await measuredRead(
                  async () => await read(fixture),
                );
                const warm = await measuredRead(
                  async () => await read(fixture),
                );
                expect(cold.statements).toBeGreaterThan(0);
                expect(cold.transactionRoundTrips).toBeGreaterThan(0);
                expect(cold.dbResultBytes).toBeGreaterThan(
                  fixture.payloadBytes,
                );
                expect(cold.astParses).toBeGreaterThan(0);
                expect(warm.statements).toBeGreaterThan(0);
                expect(warm.statements).toBeLessThan(cold.statements);
                expect(warm.transactionRoundTrips).toBeGreaterThan(0);
                expect(warm.dbResultBytes).toBeLessThan(
                  fixture.payloadBytes / 2,
                );
                expect(warm.astParses).toBe(0);
                expect(warm.storageReadBytes).toBe(0);
                expect(warm.cacheHits).toBeGreaterThan(0);
                console.info(
                  "production-window-budget",
                  JSON.stringify({ profile, scale, cold, warm }),
                );
                // Redaction must be checked again before any warmed payload is served.
                await db
                  .update(caseLawDecisions)
                  .set({ redactedAt: new Date("2026-01-01T00:00:00Z") })
                  .where(eq(caseLawDecisions.sourceId, fixture.sourceId));
                await expectRedacted(profile, fixture);
                return { cold, warm, payloadBytes: fixture.payloadBytes };
              } finally {
                resetPublicCaseLawConfigForTesting();
              }
            },
          );
          measurements.push(measurement);
        }
        const small = measurements.at(0) ?? panic("Missing 1x measurement");
        const large = measurements.at(1) ?? panic("Missing 10x measurement");
        expect(
          large.cold.dbResultBytes - small.cold.dbResultBytes,
        ).toBeGreaterThanOrEqual(large.payloadBytes - small.payloadBytes);
        expect(large.warm.statements).toBe(small.warm.statements);
        expect(large.warm.transactionRoundTrips).toBe(
          small.warm.transactionRoundTrips,
        );
        expect(large.warm.dbResultBytes).toBeLessThanOrEqual(
          small.warm.dbResultBytes + 256,
        );
      }
    });
  },
);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
  caseLawProvisionCitations,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import {
  APP_READER_TEXT,
  type AppReaderText,
} from "@/api/lib/legal-search/adapter-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import type { McpRequestContext } from "@/api/mcp/context";
import { DECISION_READER_TOOL_SET } from "@/api/mcp/decision-reader-tools";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import { readDecisionReaderSource } from "./reader";
import type { ReaderSourceOptions } from "./reader";

const DB_SETUP_TIMEOUT_MS = 120_000;
// Warm embedded-Postgres point reads must finish well inside the request budget.
const READER_READ_MAX_MS = 1500;
const READER_QUERY_MAX_STATEMENTS = 15;
// Provision placement also opens the batched legislation read transaction.
const PROVISION_QUERY_MAX_STATEMENTS = 20;
const SMALL_BLOCK_COUNT = 1;
const LARGE_BLOCK_COUNT = 250;
const LARGE_CITATION_COUNT = 40;

const sourceId = createSafeId<"caseLawSource">();
const withheldSourceId = createSafeId<"caseLawSource">();
const restrictedSourceId = createSafeId<"caseLawSource">();
const smallId = createSafeId<"caseLawDecision">();
const largeId = createSafeId<"caseLawDecision">();
const withheldId = createSafeId<"caseLawDecision">();
const restrictedId = createSafeId<"caseLawDecision">();
const listingOnlyId = createSafeId<"caseLawDecision">();
const redactedId = createSafeId<"caseLawDecision">();
const unavailableCountryId = createSafeId<"caseLawDecision">();
const missingId = createSafeId<"caseLawDecision">();
const provisionSmallId = createSafeId<"caseLawDecision">();
const provisionLargeId = createSafeId<"caseLawDecision">();
const provisionStaleId = createSafeId<"caseLawDecision">();
const statuteSourceId = createSafeId<"legislationSource">();
const statuteId = createSafeId<"legislationDocument">();
const PROVISION_COUNT = 31;
const PROVISION_PAGE_SIZE = 20;
const STATUTE_ELI = "CZ/2012/89";
const PROVISION_DATE = "2018-06-01";

const citationText = (index: number) => `40 Cdo ${index + 1}/2026`;
type ReaderAstOptions = { blockCount: number; citationCount: number };
const documentAst = ({ blockCount, citationCount }: ReaderAstOptions) =>
  ({
    version: 1,
    source: {
      system: "reader-test",
      documentId: "synthetic",
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: "Reader fixture",
      ecli: null,
      court: "Court",
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: Array.from({ length: blockCount }, (_, index) => {
      const plainText =
        index < citationCount
          ? `Reference ${citationText(index)}.`
          : `Paragraph ${index + 1}.`;
      return {
        type: "paragraph",
        id: `block-${index}`,
        anchorId: `paragraph-${index}`,
        number: index + 1,
        plainText,
        inlines: [{ type: "text", text: plainText }],
      } satisfies Block;
    }),
  }) satisfies DocumentAst;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let caseLawDb: CaseLawPublicReadDb;
let revokeSource: () => Promise<void>;
let legislationDb: LegislationReadDb;
let bumpProvisionGeneration: () => Promise<void>;

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({
      client,
      relations: databaseRelations,
      logger: queryCountLogger,
    });
    const readCases = async <T>(
      read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      );
    caseLawDb = Object.assign(readCases, caseLawPublicReadDb);
    legislationDb = async <T>(
      read: (tx: LegislationReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) => await read(asTestRaw<LegislationReadTransaction>(tx)),
      );
    bumpProvisionGeneration = async () => {
      await db.execute(
        sql`UPDATE case_law_provision_extractions SET generation = generation + 1 WHERE decision_id = ${provisionLargeId}`,
      );
    };
    await db.execute(
      sql`INSERT INTO case_law_provision_extraction_scopes (country, language, status, generation) VALUES ('CZE', 'cs', 'active', 1)`,
    );
    await db.execute(
      sql`INSERT INTO case_law_provision_extraction_revisions_registry (revision, jurisdiction, engine_input_digest, profile_digest, projection_revision) VALUES (1, 'CZE', ${"1".repeat(64)}, ${"2".repeat(64)}, 1)`,
    );
    await db.execute(
      sql`INSERT INTO case_law_provision_extraction_revisions (jurisdiction, desired_revision, min_current_revision) VALUES ('CZE', 1, 1)`,
    );
    for (const { relation, column } of publicLawColumnPairs(
      PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
    )) {
      await db.execute(
        sql`GRANT SELECT (${sql.identifier(column)}) ON TABLE ${sql.identifier(relation)} TO stella_public_law_reader`,
      );
    }
    await db.execute(
      sql.raw(
        "GRANT EXECUTE ON FUNCTION case_law_provision_extraction_in_scope(varchar, varchar), case_law_provision_extraction_input_digest(text, date, text, text, boolean) TO stella_public_law_reader",
      ),
    );
    revokeSource = async () => {
      await db
        .update(caseLawSources)
        .set({
          descriptor: {
            license: "restricted",
            attribution: null,
            allowsRedistribution: false,
            allowsDerivedAi: false,
          },
        })
        .where(eq(caseLawSources.id, sourceId));
    };
    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        id: sourceId,
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
        adapterKey: ADAPTER_KEYS.CZ_US,
        descriptor: {
          license: "permitted-redistribution",
          attribution: null,
          allowsRedistribution: true,
          allowsDerivedAi: false,
        },
      }),
      caseLawSourceRow({
        id: restrictedSourceId,
        adapterKey: ADAPTER_KEYS.CZ_NSS,
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      }),
    ]);
    const row = (
      id: SafeId<"caseLawDecision">,
      source: SafeId<"caseLawSource">,
    ) => ({
      id,
      sourceId: source,
      caseNumber: `Reader ${id}`,
      court: "Court",
      country: "CZE",
      language: "cs",
    });
    const smallAst = documentAst({
      blockCount: SMALL_BLOCK_COUNT,
      citationCount: 1,
    });
    const largeAst = documentAst({
      blockCount: LARGE_BLOCK_COUNT,
      citationCount: LARGE_CITATION_COUNT,
    });
    await db.insert(caseLawDecisions).values([
      {
        ...row(smallId, sourceId),
        documentAst: smallAst,
      },
      {
        ...row(largeId, sourceId),
        documentAst: largeAst,
      },
      {
        ...row(withheldId, withheldSourceId),
        documentAst: smallAst,
      },
      {
        ...row(restrictedId, restrictedSourceId),
        documentAst: smallAst,
      },
      {
        ...row(listingOnlyId, sourceId),
        metadata: {
          [PARTIAL_OBSERVATION_KEY]: {
            [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
          },
        },
      },
      {
        ...row(redactedId, sourceId),
        redactedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        ...row(unavailableCountryId, sourceId),
        country: "XAA",
        documentAst: smallAst,
      },
    ]);
    const provisionAst = (count: number) => {
      const ast = documentAst({ blockCount: count, citationCount: 0 });
      return {
        ...ast,
        blocks: ast.blocks.map((block, index) => {
          const plainText = `§ ${index + 1} odst. 1`;
          return {
            ...block,
            plainText,
            inlines: [{ type: "text", text: plainText }],
          } satisfies Block;
        }),
      };
    };
    const statuteAst = documentAst({ blockCount: 0, citationCount: 0 });
    const statuteBlocks = Array.from(
      { length: PROVISION_COUNT },
      (_, index) =>
        [
          {
            type: "heading",
            id: `h-${index}`,
            anchorId: `par_${index + 1}`,
            level: 3,
            plainText: `§ ${index + 1}`,
            inlines: [{ type: "text", text: `§ ${index + 1}` }],
          },
          {
            type: "paragraph",
            id: `s-${index}`,
            anchorId: `par_${index + 1}-odst_1`,
            plainText: `Wording ${index + 1}.`,
            inlines: [{ type: "text", text: `Wording ${index + 1}.` }],
          },
        ] satisfies Block[],
    ).flat();
    const legislationAst = {
      ...statuteAst,
      blocks: statuteBlocks,
    } satisfies DocumentAst;
    await db.insert(legislationSources).values({
      id: statuteSourceId,
      adapterKey: "reader-statute",
      name: "Reader statute",
      descriptor: {
        license: "public-domain",
        allowsRedistribution: true,
        allowsDerivedAi: true,
        attribution: null,
      },
    });
    await db.insert(legislationDocuments).values({
      id: statuteId,
      sourceId: statuteSourceId,
      country: "CZE",
      language: "cs",
      title: "Reader statute",
      eli: STATUTE_ELI,
      versionValidFrom: "2014-01-01",
      documentAst: legislationAst,
    });
    for (const [decisionId, count] of [
      [provisionSmallId, 1],
      [provisionLargeId, PROVISION_COUNT],
      [provisionStaleId, 1],
    ] as const) {
      const ast = provisionAst(count);
      await db.insert(caseLawDecisions).values({
        ...row(decisionId, sourceId),
        documentAst: ast,
        decisionDate: PROVISION_DATE,
        contentHash: "c".repeat(64),
        corpusMirrorStatus: "settled",
      });
      await db.insert(caseLawProvisionCitations).values(
        ast.blocks.map((block, index) => ({
          id: createSafeId<"caseLawProvisionCitation">(),
          decisionId,
          jurisdiction: "CZE",
          workIdentifier: "89/2012 Sb.",
          workNumber: 89,
          workYear: 2012,
          workCollection: "Sb.",
          workEli: STATUTE_ELI,
          unit: "section" as const,
          section: index + 1,
          subsection: "1",
          anchor: `par_${index + 1}-odst_1`,
          spanStart: index * 100,
          spanEnd: index * 100 + block.plainText.length,
          sentenceText: block.plainText,
          confidence: 1,
          spanRole: "printed" as const,
          printPieceId: block.id,
          printStart: 0,
          printEnd: block.plainText.length,
          printText: block.plainText,
        })),
      );
      const digest =
        decisionId === provisionStaleId
          ? "f".repeat(64)
          : await projectionDigest(ast);
      await db.execute(
        sql`UPDATE case_law_provision_extractions SET generation = generation + 1, outcome = 'extracted_with_rows', row_count = ${count}, rows_digest = ${"b".repeat(64)}, published_projection_digest = decode(${digest}, 'hex'), published_revision = 1, published_jurisdiction = 'CZE', published_input_digest = desired_input_digest, published_at = now(), due_at = NULL WHERE decision_id = ${decisionId}`,
      );
    }
    await db.insert(caseLawCitations).values([
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: smallId,
        citedDecisionId: largeId,
        citationText: citationText(0),
      },
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: withheldId,
        citedDecisionId: largeId,
        citationText: citationText(0),
      },
      ...Array.from({ length: LARGE_CITATION_COUNT }, (_, index) => ({
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: largeId,
        citedDecisionId: smallId,
        citationText: citationText(index),
      })),
    ]);
  },
  { timeout: DB_SETUP_TIMEOUT_MS },
);

afterAll(async () => await client.close());

const read = async (
  decisionId: SafeId<"caseLawDecision">,
  phase: "blocks" | "citations" | "provisions",
) =>
  await readDecisionReaderSource({
    caseLawDb,
    legislationDb,
    decisionId,
    phase,
    audience: "model",
  });
const measuredRead = async (
  decisionId: SafeId<"caseLawDecision">,
  phase: "blocks" | "citations" | "provisions",
) =>
  await runWithQueryCounter(async (counter) => {
    const started = performance.now();
    const result = await read(decisionId, phase);
    return {
      result,
      statements: counter.count,
      elapsedMs: performance.now() - started,
    };
  });

describe("public decision reader database boundary", () => {
  test("unpublished, restricted, unavailable-country and missing decisions expose no reader data", async () => {
    for (const decisionId of [
      listingOnlyId,
      restrictedId,
      unavailableCountryId,
      missingId,
    ]) {
      for (const phase of ["blocks", "citations", "provisions"] as const) {
        expect(await read(decisionId, phase)).toBeNull();
      }
    }
  });

  test("redacted decisions retain metadata but expose no AST or anchors", async () => {
    for (const phase of ["blocks", "citations", "provisions"] as const) {
      const result = await read(redactedId, phase);
      expect(result?.status).toBe("read");
      if (result?.status !== "read") {
        throw new Error("Expected redacted decision metadata");
      }
      expect(result.decision.id).toBe(redactedId);
      expect(result.ast).toBeNull();
      expect(result.citationAnchors).toEqual([]);
      expect(result.provisionAnchors).toEqual([]);
    }
  });

  test("text kept from AI skips citation reads for the model while the app reader locates real anchors", async () => {
    const metadataOnly = await measuredRead(withheldId, "citations");
    const visible = await runWithQueryCounter(async (counter) => {
      const result = await readDecisionReaderSource({
        caseLawDb,
        decisionId: withheldId,
        phase: "citations",
        audience: "app",
        appReaderTextOf: () => APP_READER_TEXT.FULL,
      });
      return { result, statements: counter.count };
    });
    expect(metadataOnly.result?.status).toBe("read");
    expect(visible.result?.status).toBe("read");
    if (
      metadataOnly.result?.status !== "read" ||
      visible.result?.status !== "read"
    ) {
      throw new Error("Expected reader sources for withheld decision");
    }
    expect(metadataOnly.result.textAccess).toBe("withheld");
    expect(metadataOnly.result.ast).toBeNull();
    expect(visible.result.textAccess).toBe("readable");
    expect(metadataOnly.result.citationAnchors).toEqual([]);
    expect(visible.result.citationAnchors).toHaveLength(1);
    expect(visible.result.citationAnchors.at(0)?.decisionId).toBe(largeId);
    expect(metadataOnly.statements).toBeLessThan(visible.statements);
  });

  test("the app reader follows the source's setting for text kept from AI", async () => {
    const body =
      documentAst({
        blockCount: SMALL_BLOCK_COUNT,
        citationCount: 1,
      }).blocks.at(-1)?.plainText ?? "";
    expect(body).not.toBe("");
    const blocksFor = async (appReaderText: AppReaderText) =>
      await DECISION_READER_TOOL_SET.handlers.read_case_law_decision_blocks({
        args: { decision_id: withheldId },
        context: asTestRaw<McpRequestContext>({
          testDependencies: {
            readDecisionReaderSource: async (options: ReaderSourceOptions) =>
              await readDecisionReaderSource({
                ...options,
                caseLawDb,
                legislationDb,
                appReaderTextOf: () => appReaderText,
              }),
          },
        }),
      });
    const full = await blocksFor(APP_READER_TEXT.FULL);
    expect(full).toMatchObject({
      status: "success",
      data: { content: { status: "available" } },
    });
    expect(JSON.stringify(full)).toContain(body);

    const metadataOnly = await blocksFor(APP_READER_TEXT.METADATA_ONLY);
    expect(metadataOnly).toMatchObject({
      status: "success",
      data: { content: { status: "withheld" } },
    });
    expect(JSON.stringify(metadataOnly)).not.toContain(body);
  });

  test("query counts stay constant as blocks and citations grow; warm reads stay bounded", async () => {
    // Warm lazy court-registry reads and both document shapes before timing.
    await read(smallId, "citations");
    await read(largeId, "citations");
    for (const phase of ["blocks", "citations"] as const) {
      const small = await measuredRead(smallId, phase);
      const large = await measuredRead(largeId, phase);
      expect(small.result?.status).toBe("read");
      expect(large.result?.status).toBe("read");
      if (small.result?.status !== "read" || large.result?.status !== "read") {
        throw new Error("Expected complete reader sources");
      }
      expect(small.result.ast?.blocks).toHaveLength(SMALL_BLOCK_COUNT);
      expect(large.result.ast?.blocks).toHaveLength(LARGE_BLOCK_COUNT);
      if (phase === "citations") {
        expect(small.result.citationAnchors).toHaveLength(1);
        expect(large.result.citationAnchors).toHaveLength(LARGE_CITATION_COUNT);
      }
      expect(small.statements).toBeGreaterThan(0);
      expect(large.statements).toBe(small.statements);
      expect(large.statements).toBeLessThanOrEqual(READER_QUERY_MAX_STATEMENTS);
      expect(small.elapsedMs).toBeLessThan(READER_READ_MAX_MS);
      expect(large.elapsedMs).toBeLessThan(READER_READ_MAX_MS);
    }
  });

  test("provision anchors are produced by the real batched preview services without N+1 reads", async () => {
    await read(provisionSmallId, "provisions");
    await read(provisionLargeId, "provisions");
    const small = await measuredRead(provisionSmallId, "provisions");
    const large = await measuredRead(provisionLargeId, "provisions");
    expect(small.result?.status).toBe("read");
    expect(large.result?.status).toBe("read");
    if (small.result?.status !== "read" || large.result?.status !== "read") {
      throw new Error("Expected provision sources");
    }
    expect(small.result.provisionAnchors).toHaveLength(1);
    expect(large.result.provisionAnchors).toHaveLength(PROVISION_PAGE_SIZE);
    expect(small.result.provisionAnchors.at(0)).toMatchObject({
      pieceId: "block-0",
      start: 0,
      end: "§ 1 odst. 1".length,
      provision: {
        document_id: statuteId,
        anchor: "par_1",
        cited_anchor: "par_1-odst_1",
      },
    });
    expect(large.result.referenceNextCursor).not.toBeNull();
    expect(small.statements).toBeGreaterThan(0);
    expect(large.statements).toBe(small.statements);
    expect(large.statements).toBeLessThanOrEqual(
      PROVISION_QUERY_MAX_STATEMENTS,
    );
    expect(small.elapsedMs).toBeLessThan(READER_READ_MAX_MS);
    expect(large.elapsedMs).toBeLessThan(READER_READ_MAX_MS);
  });

  test("all provision anchors round-trip across source pages exactly once", async () => {
    const anchors: string[] = [];
    const cursors = new Set<string>();
    let referenceCursor: string | undefined;
    for (let pages = 0; pages < 3; pages += 1) {
      const result = await readDecisionReaderSource({
        caseLawDb,
        legislationDb,
        decisionId: provisionLargeId,
        phase: "provisions",
        audience: "model",
        ...(referenceCursor === undefined ? {} : { referenceCursor }),
      });
      expect(result?.status).toBe("read");
      if (result?.status !== "read") {
        throw new Error("Expected a provision source page");
      }
      anchors.push(
        ...result.provisionAnchors.map(
          ({ provision }) => provision.cited_anchor,
        ),
      );
      if (result.referenceNextCursor === null) {
        referenceCursor = undefined;
        break;
      }
      expect(cursors.has(result.referenceNextCursor)).toBe(false);
      cursors.add(result.referenceNextCursor);
      referenceCursor = result.referenceNextCursor;
    }
    expect(referenceCursor).toBeUndefined();
    expect(anchors).toEqual(
      Array.from(
        { length: PROVISION_COUNT },
        (_, index) => `par_${index + 1}-odst_1`,
      ),
    );
    expect(new Set(anchors).size).toBe(PROVISION_COUNT);
    expect(cursors.size).toBe(1);
  });

  test("a stale projection never supplies guessed provision anchors", async () => {
    const result = await read(provisionStaleId, "provisions");
    expect(result?.status).toBe("read");
    if (result?.status !== "read") {
      throw new Error("Expected stale projection source");
    }
    expect(result.ast?.blocks).toHaveLength(1);
    expect(result.provisionAnchors).toEqual([]);
  });

  test("a provision generation change refuses an old source cursor", async () => {
    const first = await read(provisionLargeId, "provisions");
    if (first?.status !== "read" || first.referenceNextCursor === null) {
      throw new Error("Expected provision continuation cursor");
    }
    await bumpProvisionGeneration();
    expect(
      await readDecisionReaderSource({
        caseLawDb,
        legislationDb,
        decisionId: provisionLargeId,
        phase: "provisions",
        audience: "model",
        referenceCursor: first.referenceNextCursor,
      }),
    ).toEqual({ status: "conflict" });
  });

  test("redistribution revocation is checked again on the next reader call", async () => {
    expect((await read(smallId, "blocks"))?.status).toBe("read");
    await revokeSource();
    for (const phase of ["blocks", "citations", "provisions"] as const) {
      expect(await read(smallId, phase)).toBeNull();
    }
  });
});

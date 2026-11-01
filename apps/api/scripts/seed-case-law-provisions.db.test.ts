/**
 * The synthetic provision links, seeded the way the local seed writes them
 * and read back through the handlers behind the decision reader's links and
 * a provision's citing-decision lists.
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { compareCodeUnit } from "@stll/collation";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import {
  projectionDigest,
  projectionPieces,
} from "@stll/legal-ast/projection-digest";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawProvisionExtractions,
  caseLawSources,
} from "@/api/db/schema";
import { readStatuteCitationCountsHandler } from "@/api/handlers/case-law/provisions/citation-counts";
import { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import { isHttpStatusResponse } from "@/api/http/status";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { provisionAnchorSubtreeSql } from "@/api/lib/case-law/provision-anchor-lineage";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { FIXTURE_SOURCE_KEYS } from "@/api/lib/legal-search/adapter-manifest";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import { segmentDecision } from "@/api/lib/legal-search/segment-decision";
import {
  PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import { fixtureDecisionRow, fixtureSourceRow } from "./seed-case-law";
import {
  provisionCitationRows,
  readSyntheticSeedDecision,
  seedSyntheticProvisionLinks,
} from "./seed-case-law-provisions";
import type { SeededDecision } from "./seed-case-law-provisions";
import {
  AUTHORED_PROVISION_CITATIONS,
  syntheticCaseLawFixtures,
} from "./seed-case-law-synthetic";
import { seededStatuteEli } from "./seed-legislation";
import { seedId } from "./seed-utils";

const PGLITE_SEED_SETUP_TIMEOUT_MS = 120_000;
const LABOUR_CODE_ELI = seededStatuteEli({ year: 2006, number: 262 });
const SECTION_51 = "par_51";
const LEGACY_CASE_NUMBER =
  [...AUTHORED_PROVISION_CITATIONS.keys()].at(0) ??
  panic("No authored citation fixture");
// An earlier writer chose an ID unrelated to the current deterministic seed ID.
const LEGACY_DECISION_ID = seedId<"caseLawDecision">(
  "previous-writer-synthetic-provision-case",
);
const CHANGED_INPUT_DECISION_ID = seedId<"caseLawDecision">(
  "synthetic-provision-input-changed-after-preparation",
);
let changedInputFailure: unknown;
let changedInputSnapshot: SeededDecision;
// A payload rewritten under its old content hash, so the input digest holds.
const CHANGED_PAYLOAD_DECISION_ID = seedId<"caseLawDecision">(
  "synthetic-provision-payload-changed-after-preparation",
);
let changedPayloadFailure: unknown;
const CHANGED_PAYLOAD_SUFFIX = " Doplněno po přípravě.";
const LEGACY_PREFIX = "Starší místní podoba. ";
const LEGACY_PREFIX_INLINE = { type: "text", text: LEGACY_PREFIX } as const;
const preservedDecisions = (["withheld", "pending"] as const).map((state) => ({
  state,
  id: seedId<"caseLawDecision">(`unchanged-synthetic-${state}`),
}));

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;
const seeded: SeededDecision[] = [];
type SeedOptions = Parameters<typeof seedSyntheticProvisionLinks>[0];

/** The reader's status columns, granted as the reader-grants rollout does. */
const grantProvisionStatusReads = async () => {
  const columnsByRelation = new Map<string, string[]>();
  for (const { relation, column } of publicLawColumnPairs(
    PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  )) {
    let columns = columnsByRelation.get(relation);
    if (columns === undefined) {
      columns = [];
      columnsByRelation.set(relation, columns);
    }
    columns.push(column);
  }
  for (const [relation, columns] of columnsByRelation) {
    await db.execute(
      sql`GRANT SELECT (${sql.join(
        columns.map((column) => sql.identifier(column)),
        sql`, `,
      )}) ON TABLE ${sql.identifier(relation)} TO stella_public_law_reader`,
    );
  }
  await db.execute(
    sql.raw(`GRANT EXECUTE ON FUNCTION
      case_law_provision_extraction_in_scope(varchar, varchar),
      case_law_provision_extraction_input_digest(text, date, text, text, boolean)
      TO stella_public_law_reader`),
  );
};

// timeout: Build the cold PGlite schema, seed synthetic cases, and finish both provision-link passes before assertions.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  caseLawDb = asTestRaw<CaseLawPublicReadDb>(
    async <T>(read: (tx: CaseLawPublicReadTransaction) => Promise<T>) =>
      await withPublicLawReaderRole(
        db,
        async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      ),
  );
  await grantProvisionStatusReads();

  for (const { source, decisions } of syntheticCaseLawFixtures()) {
    const sourceRow = fixtureSourceRow(source);
    await db.insert(caseLawSources).values(sourceRow);
    for (const decision of decisions) {
      const isLegacy = decision.case_number === LEGACY_CASE_NUMBER;
      let storedDecision = decision;
      if (isLegacy) {
        if (
          !isDocumentAst(decision.document_ast) ||
          decision.fulltext === null
        ) {
          panic("Legacy fixture has no document");
        }
        const fulltext = LEGACY_PREFIX + decision.fulltext;
        storedDecision = {
          ...decision,
          fulltext,
          sections: segmentDecision(fulltext),
          document_ast: {
            ...decision.document_ast,
            blocks: decision.document_ast.blocks.map((block, index) =>
              index === 0 && block.type === "paragraph"
                ? {
                    ...block,
                    inlines: [LEGACY_PREFIX_INLINE, ...block.inlines],
                    plainText: LEGACY_PREFIX + block.plainText,
                  }
                : block,
            ),
          },
        };
      }
      const row = {
        ...fixtureDecisionRow({
          adapterKey: source.adapter_key,
          sourceId: sourceRow.id,
          decision: storedDecision,
        }),
        ...(isLegacy ? { id: LEGACY_DECISION_ID, contentHash: null } : {}),
      };
      await db.insert(caseLawDecisions).values(row);
      if (source.adapter_key === FIXTURE_SOURCE_KEYS.SYNTHETIC_CZ) {
        const prepared = await readSyntheticSeedDecision(
          asTestRaw<SeedOptions["rootDb"]>(db),
          row.id,
        );
        seeded.push(
          prepared ?? panic("Seeded fixture is unexpectedly withheld"),
        );
      }
    }
  }
  const fixture =
    syntheticCaseLawFixtures().find(
      ({ source }) => source.adapter_key === FIXTURE_SOURCE_KEYS.SYNTHETIC_CZ,
    ) ?? panic("No Czech source");
  const decision = fixture.decisions.at(0) ?? panic("No Czech decision");
  for (const { state, id } of preservedDecisions) {
    const row = {
      ...fixtureDecisionRow({
        adapterKey: fixture.source.adapter_key,
        sourceId: fixtureSourceRow(fixture.source).id,
        decision,
      }),
      id,
      caseNumber: `DEMO preserved ${state}`,
      contentHash: null,
      ...(state === "withheld"
        ? {
            redactedAt: new Date("2026-01-01T00:00:00Z"),
            fulltext: null,
            sections: null,
            documentAst: null,
          }
        : { corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING }),
    };
    await db.insert(caseLawDecisions).values(row);
  }
  const options = {
    rootDb: asTestRaw<SeedOptions["rootDb"]>(db),
    // The embedded database is one session: the backfill's BEGIN and COMMIT
    // go through the same client as its statements.
    backfill: {
      setTransactionBudget: async () => undefined,
      execute: async (query, params = []) => {
        await client.query(query, [...params]);
      },
      query: async (query, params = []) =>
        (await client.query(query, [...params])).rows,
    },
    decisions: seeded,
  } satisfies SeedOptions;
  const authored =
    fixture.decisions.find(
      ({ case_number }) => case_number === LEGACY_CASE_NUMBER,
    ) ?? panic("No authored decision for the publication fence");
  await db.insert(caseLawDecisions).values({
    ...fixtureDecisionRow({
      adapterKey: fixture.source.adapter_key,
      sourceId: fixtureSourceRow(fixture.source).id,
      decision: authored,
    }),
    id: CHANGED_INPUT_DECISION_ID,
    sourceDocumentId: "synthetic-publication-input-fence",
    slug: null,
  });
  changedInputSnapshot =
    (await readSyntheticSeedDecision(
      asTestRaw<SeedOptions["rootDb"]>(db),
      CHANGED_INPUT_DECISION_ID,
    )) ?? panic("Publication fence fixture was withheld");
  // One committed input change between preparation and publication, without
  // a timing race or a replacement fixture standing in for the stored row.
  await db
    .update(caseLawDecisions)
    .set({ decisionDate: sql`${caseLawDecisions.decisionDate} + 1` })
    .where(eq(caseLawDecisions.id, CHANGED_INPUT_DECISION_ID));
  changedInputFailure = await rejectionOf(
    seedSyntheticProvisionLinks({
      ...options,
      decisions: [changedInputSnapshot],
    }),
  );
  await db.insert(caseLawDecisions).values({
    ...fixtureDecisionRow({
      adapterKey: fixture.source.adapter_key,
      sourceId: fixtureSourceRow(fixture.source).id,
      decision: authored,
    }),
    id: CHANGED_PAYLOAD_DECISION_ID,
    sourceDocumentId: "synthetic-publication-payload-fence",
    slug: null,
  });
  const changedPayloadSnapshot =
    (await readSyntheticSeedDecision(
      asTestRaw<SeedOptions["rootDb"]>(db),
      CHANGED_PAYLOAD_DECISION_ID,
    )) ?? panic("Payload fence fixture was withheld");
  await db
    .update(caseLawDecisions)
    .set({
      fulltext: sql`${caseLawDecisions.fulltext} || ${CHANGED_PAYLOAD_SUFFIX}`,
    })
    .where(eq(caseLawDecisions.id, CHANGED_PAYLOAD_DECISION_ID));
  changedPayloadFailure = await rejectionOf(
    seedSyntheticProvisionLinks({
      ...options,
      decisions: [changedPayloadSnapshot],
    }),
  );
  await seedSyntheticProvisionLinks(options);
  // A re-seed converges on the same rows and the same published state.
  await seedSyntheticProvisionLinks(options);
}, PGLITE_SEED_SETUP_TIMEOUT_MS);

afterAll(async () => await client.close());

const seededByCaseNumber = (caseNumber: string) =>
  seeded.find(({ decision }) => decision.case_number === caseNumber) ??
  panic(`${caseNumber} was not seeded`);

const linkedCaseNumbers = [...AUTHORED_PROVISION_CITATIONS]
  .filter(([, citations]) => citations.length > 0)
  .map(([caseNumber]) => caseNumber);

const provisionPage = async (caseNumber: string) => {
  const page = await withRedistributableSubject(
    caseLawDb,
    "pages",
    { kind: "id", id: seededByCaseNumber(caseNumber).id },
    async (subject) =>
      await listDecisionProvisionsHandler({ subject, query: { limit: 100 } }),
  );
  if (page === null || !("items" in page)) {
    return panic(`${caseNumber} has no provision page`);
  }
  return page;
};

test("each linked decision serves current provision spans that slice to the printed text", async () => {
  expect(linkedCaseNumbers.length).toBeGreaterThanOrEqual(3);
  for (const caseNumber of linkedCaseNumbers) {
    const { decision } = seededByCaseNumber(caseNumber);
    const ast = decision.document_ast;
    if (!isDocumentAst(ast) || decision.fulltext === null) {
      panic(`${caseNumber} has no readable text`);
    }
    const page = await provisionPage(caseNumber);
    expect(page.status).toEqual({ type: "current" });
    expect(page.items.map(({ anchor }) => anchor)).toContain(SECTION_51);
    const pieces = new Map(
      projectionPieces(ast).map(({ pieceId, text }) => [pieceId, text]),
    );
    for (const item of page.items) {
      expect(item.workEli).toBe(LABOUR_CODE_ELI);
      const piece =
        pieces.get(item.printPieceId ?? "") ?? panic("span has no piece");
      expect(piece.slice(item.printStart ?? 0, item.printEnd ?? 0)).toBe(
        item.printText ?? "",
      );
      // The reader places a link by its sentence, so the sentence must
      // name exactly one place in the decision.
      expect(decision.fulltext.split(item.sentenceText)).toHaveLength(2);
    }
  }
});

test("a synthetic decision printing no provision is current with no links", async () => {
  const generated =
    seeded.find(
      ({ decision }) => !AUTHORED_PROVISION_CITATIONS.has(decision.case_number),
    ) ?? panic("no generated decision");
  const page = await provisionPage(generated.decision.case_number);
  expect(page.status).toEqual({ type: "current" });
  expect(page.items).toEqual([]);
});

test("§ 51 of the labour code lists every linked decision with its mention count", async () => {
  const response = await listCitingDecisionsHandler(
    { jurisdiction: "CZE", eli: LABOUR_CODE_ELI, anchor: SECTION_51 },
    { caseLawDb, courtRegistry: new Map() },
  );
  if (isHttpStatusResponse(response)) {
    panic(`Citing decisions answered ${String(response.code)}`);
  }
  expect(
    response.items
      .map(({ caseNumber }) => caseNumber)
      .toSorted(compareCodeUnit),
  ).toEqual(linkedCaseNumbers.toSorted(compareCodeUnit));
  expect(new Set(response.items.map(({ court }) => court)).size).toBe(
    linkedCaseNumbers.length,
  );
  // A section counts the citations of its subdivisions too.
  const mentions = await db
    .select({ decisionId: caseLawProvisionCitations.decisionId })
    .from(caseLawProvisionCitations)
    .where(
      provisionAnchorSubtreeSql(caseLawProvisionCitations.anchor, {
        jurisdiction: "CZE",
        anchor: SECTION_51,
      }),
    );
  for (const item of response.items) {
    expect(item.mentionCount).toBe(
      mentions.filter(({ decisionId }) => decisionId === item.decisionId)
        .length,
    );
    expect(item.sentenceText).toContain("§ 51");
  }
  expect(response.items.some(({ mentionCount }) => mentionCount > 1)).toBe(
    true,
  );

  const counts = await readStatuteCitationCountsHandler(
    { jurisdiction: "CZE", eli: LABOUR_CODE_ELI },
    caseLawDb,
  );
  if (isHttpStatusResponse(counts)) {
    panic(`Citation counts answered ${String(counts.code)}`);
  }
  expect(counts).toEqual({
    status: "ready",
    provisions: expect.arrayContaining([
      { anchor: SECTION_51, decisionCount: linkedCaseNumbers.length },
    ]),
  });
});

test("a prior seed keeps its actual ID and payload while its missing hash and provision spans converge", async () => {
  const actual = seededByCaseNumber(LEGACY_CASE_NUMBER);
  const fixture =
    syntheticCaseLawFixtures().find(
      ({ source }) => source.adapter_key === FIXTURE_SOURCE_KEYS.SYNTHETIC_CZ,
    ) ?? panic("No Czech source");
  const original =
    fixture.decisions.find(
      ({ case_number }) => case_number === LEGACY_CASE_NUMBER,
    ) ?? panic("No original authored decision");
  const originalAst = original.document_ast;
  if (!isDocumentAst(originalAst)) {
    panic("Original authored AST is missing");
  }
  expect(actual.id).toBe(LEGACY_DECISION_ID);
  expect(actual.id).not.toBe(
    fixtureDecisionRow({
      adapterKey: fixture.source.adapter_key,
      sourceId: fixtureSourceRow(fixture.source).id,
      decision: original,
    }).id,
  );
  const ast = actual.decision.document_ast;
  const text = actual.decision.fulltext;
  if (!isDocumentAst(ast) || text === null) {
    panic("Stored legacy document is missing");
  }
  expect(text).toBe(LEGACY_PREFIX + original.fulltext);
  expect(ast).not.toEqual(original.document_ast);
  const readStored = async () =>
    (
      await db
        .select({
          contentHash: caseLawDecisions.contentHash,
          fulltext: caseLawDecisions.fulltext,
          sections: caseLawDecisions.sections,
          documentAst: caseLawDecisions.documentAst,
          updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, actual.id))
    ).at(0) ?? panic("Stored legacy row is missing");
  const stored = await readStored();
  expect(stored.fulltext).toBe(text);
  expect(stored.documentAst).toEqual(ast);
  expect(stored.contentHash).toBe(
    corpusContentHash({
      text: stored.fulltext,
      sections: stored.sections,
      ast: stored.documentAst,
    }),
  );
  expect(stored.contentHash).not.toBe(
    corpusContentHash({
      text: original.fulltext,
      sections: original.sections,
      ast: original.document_ast,
    }),
  );
  expect(
    await readSyntheticSeedDecision(
      asTestRaw<SeedOptions["rootDb"]>(db),
      actual.id,
    ),
  ).toEqual(actual);
  expect(await readStored()).toEqual(stored);
  const publication =
    (
      await db
        .select({
          digest: sql<string>`encode(${caseLawProvisionExtractions.publishedProjectionDigest}, 'hex')`,
        })
        .from(caseLawProvisionExtractions)
        .where(eq(caseLawProvisionExtractions.decisionId, actual.id))
    ).at(0) ?? panic("No legacy publication");
  expect(publication.digest).toBe(await projectionDigest(ast));
  expect(publication.digest).not.toBe(await projectionDigest(originalAst));
  const citations = await db
    .select({
      start: caseLawProvisionCitations.spanStart,
      end: caseLawProvisionCitations.spanEnd,
      printText: caseLawProvisionCitations.printText,
    })
    .from(caseLawProvisionCitations)
    .where(eq(caseLawProvisionCitations.decisionId, actual.id));
  expect(citations.length).toBeGreaterThan(0);
  for (const citation of citations) {
    if (citation.printText === null) {
      panic("Authored provision citation has no printed text");
    }
    expect(text.slice(citation.start, citation.end)).toBe(citation.printText);
  }
  expect((await provisionPage(LEGACY_CASE_NUMBER)).status).toEqual({
    type: "current",
  });
});

test("repeat seeding never stamps a hash onto withheld or pending synthetic payloads", async () => {
  for (const { id } of preservedDecisions) {
    expect(
      await readSyntheticSeedDecision(asTestRaw<SeedOptions["rootDb"]>(db), id),
    ).toBeNull();
    const actual =
      (
        await db
          .select({ contentHash: caseLawDecisions.contentHash })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, id))
      ).at(0) ?? panic("Preserved synthetic row is missing");
    expect(actual.contentHash).toBeNull();
  }
});

test("a changed input cannot receive citation rows or a current publication from an older snapshot", async () => {
  expect(
    provisionCitationRows({
      decisionId: changedInputSnapshot.id,
      decision: changedInputSnapshot.decision,
      citations: AUTHORED_PROVISION_CITATIONS.get(LEGACY_CASE_NUMBER) ?? [],
    }).length,
  ).toBeGreaterThan(0);
  expect(changedInputFailure).toMatchObject({
    message: "Synthetic seed input changed before provision publication",
  });
  const state =
    (
      await db
        .select({
          inputDigest: sql<string>`encode(${caseLawProvisionExtractions.desiredInputDigest}, 'hex')`,
          outcome: caseLawProvisionExtractions.outcome,
          generation: caseLawProvisionExtractions.generation,
          publishedInputDigest:
            caseLawProvisionExtractions.publishedInputDigest,
        })
        .from(caseLawProvisionExtractions)
        .where(
          eq(caseLawProvisionExtractions.decisionId, CHANGED_INPUT_DECISION_ID),
        )
    ).at(0) ?? panic("Changed input has no owed extraction state");
  expect(state.inputDigest).not.toBe(changedInputSnapshot.inputDigest);
  expect(state.outcome).toBeNull();
  expect(state.generation).toBe(0);
  expect(state.publishedInputDigest).toBeNull();
  const rows = await db
    .select({ id: caseLawProvisionCitations.id })
    .from(caseLawProvisionCitations)
    .where(eq(caseLawProvisionCitations.decisionId, CHANGED_INPUT_DECISION_ID));
  expect(rows).toEqual([]);
});

test("a payload rewritten under its old hash cannot publish rows derived from the earlier text", async () => {
  expect(changedPayloadFailure).toMatchObject({
    message: "Synthetic seed input changed before provision publication",
  });
  const state =
    (
      await db
        .select({
          outcome: caseLawProvisionExtractions.outcome,
          generation: caseLawProvisionExtractions.generation,
        })
        .from(caseLawProvisionExtractions)
        .where(
          eq(
            caseLawProvisionExtractions.decisionId,
            CHANGED_PAYLOAD_DECISION_ID,
          ),
        )
    ).at(0) ?? panic("Changed payload has no owed extraction state");
  expect(state).toEqual({ outcome: null, generation: 0 });
  expect(
    await db
      .select({ id: caseLawProvisionCitations.id })
      .from(caseLawProvisionCitations)
      .where(
        eq(caseLawProvisionCitations.decisionId, CHANGED_PAYLOAD_DECISION_ID),
      ),
  ).toEqual([]);
});

test("a fixture row publishes although its jsonb columns no longer hash to its stored content hash", async () => {
  const caseNumber = linkedCaseNumbers.find(
    (candidate) => candidate !== LEGACY_CASE_NUMBER,
  );
  const { id } = seededByCaseNumber(
    caseNumber ?? panic("No fixture-hashed linked decision"),
  );
  const stored =
    (
      await db
        .select({
          contentHash: caseLawDecisions.contentHash,
          fulltext: caseLawDecisions.fulltext,
          sections: caseLawDecisions.sections,
          documentAst: caseLawDecisions.documentAst,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, id))
    ).at(0) ?? panic("Linked fixture row is missing");
  // jsonb reorders object keys, so the stored columns re-serialize differently.
  expect(stored.contentHash).not.toBe(
    corpusContentHash({
      text: stored.fulltext,
      sections: stored.sections,
      ast: stored.documentAst,
    }),
  );
  const publication =
    (
      await db
        .select({ outcome: caseLawProvisionExtractions.outcome })
        .from(caseLawProvisionExtractions)
        .where(eq(caseLawProvisionExtractions.decisionId, id))
    ).at(0) ?? panic("Linked fixture has no publication");
  expect(publication.outcome).toBe("extracted_with_rows");
});

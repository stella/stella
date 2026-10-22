/**
 * The synthetic provision links, seeded the way the local seed writes them
 * and read back through the handlers behind the decision reader's links and
 * a provision's citing-decision lists.
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { projectionPieces } from "@stll/legal-ast/projection-digest";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
} from "@/api/db/schema";
import { readStatuteCitationCountsHandler } from "@/api/handlers/case-law/provisions/citation-counts";
import { listCitingDecisionsHandler } from "@/api/handlers/case-law/provisions/citing-decisions";
import { listDecisionProvisionsHandler } from "@/api/handlers/case-law/provisions/list-for-decision";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { FIXTURE_SOURCE_KEYS } from "@/api/lib/legal-search/adapter-manifest";
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
import { seedSyntheticProvisionLinks } from "./seed-case-law-provisions";
import type { SeededDecision } from "./seed-case-law-provisions";
import {
  AUTHORED_PROVISION_CITATIONS,
  syntheticCaseLawFixtures,
} from "./seed-case-law-synthetic";
import { seededStatuteEli } from "./seed-legislation";

const DB_TEST_TIMEOUT_MS = 120_000;
const LABOUR_CODE_ELI = seededStatuteEli({ year: 2006, number: 262 });
const SECTION_51 = "par_51";

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
    columnsByRelation.set(relation, [
      ...(columnsByRelation.get(relation) ?? []),
      column,
    ]);
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
      const row = fixtureDecisionRow({
        adapterKey: source.adapter_key,
        sourceId: sourceRow.id,
        decision,
      });
      await db.insert(caseLawDecisions).values(row);
      if (source.adapter_key === FIXTURE_SOURCE_KEYS.SYNTHETIC_CZ) {
        seeded.push({ id: row.id, decision });
      }
    }
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
  await seedSyntheticProvisionLinks(options);
  // A re-seed converges on the same rows and the same published state.
  await seedSyntheticProvisionLinks(options);
}, DB_TEST_TIMEOUT_MS);

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

test(
  "each linked decision serves current provision spans that slice to the printed text",
  async () => {
    expect(linkedCaseNumbers.length).toBeGreaterThanOrEqual(3);
    for (const caseNumber of linkedCaseNumbers) {
      const { decision } = seededByCaseNumber(caseNumber);
      const ast = decision.document_ast;
      if (!isDocumentAst(ast) || decision.fulltext === null) {
        return panic(`${caseNumber} has no readable text`);
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
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a synthetic decision printing no provision is current with no links",
  async () => {
    const generated =
      seeded.find(
        ({ decision }) =>
          !AUTHORED_PROVISION_CITATIONS.has(decision.case_number),
      ) ?? panic("no generated decision");
    const page = await provisionPage(generated.decision.case_number);
    expect(page.status).toEqual({ type: "current" });
    expect(page.items).toEqual([]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "§ 51 of the labour code lists every linked decision with its mention count",
  async () => {
    const response = await listCitingDecisionsHandler(
      { jurisdiction: "CZE", eli: LABOUR_CODE_ELI, anchor: SECTION_51 },
      { caseLawDb, courtRegistry: new Map() },
    );
    if (response instanceof ElysiaCustomStatusResponse) {
      return panic(`Citing decisions answered ${String(response.code)}`);
    }
    expect(
      response.items.map(({ caseNumber }) => caseNumber).toSorted(),
    ).toEqual(linkedCaseNumbers.toSorted());
    expect(new Set(response.items.map(({ court }) => court)).size).toBe(
      linkedCaseNumbers.length,
    );
    const mentions = await db
      .select({ decisionId: caseLawProvisionCitations.decisionId })
      .from(caseLawProvisionCitations)
      .where(sql`${caseLawProvisionCitations.anchor} = ${SECTION_51}`);
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
    if (counts instanceof ElysiaCustomStatusResponse) {
      return panic(`Citation counts answered ${String(counts.code)}`);
    }
    expect(counts).toEqual({
      status: "ready",
      provisions: expect.arrayContaining([
        { anchor: SECTION_51, decisionCount: linkedCaseNumbers.length },
      ]),
    });
  },
  DB_TEST_TIMEOUT_MS,
);

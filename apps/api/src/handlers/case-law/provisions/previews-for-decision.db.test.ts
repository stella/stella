import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { attachDecisionProvisionPreviews } from "@/api/handlers/case-law/provisions/previews-for-decision";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import type { Page } from "@/api/lib/pagination";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const CIVIL_CODE_ELI = "CZ/2012/89";
const WITHHELD_ELI = "CZ/2020/123";
const UNHELD_ELI = "CZ/1963/99";
const DECISION_DATE = "2018-06-01";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;

const openSourceId = createSafeId<"legislationSource">();
const closedSourceId = createSafeId<"legislationSource">();
const civilCodeOld = createSafeId<"legislationDocument">();
const civilCodeCurrent = createSafeId<"legislationDocument">();
const withheldAct = createSafeId<"legislationDocument">();

const paragraph = (id: string, anchorId: string, text: string): Block => ({
  anchorId,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

const statuteAst = (wording: string): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      anchorId: "par_1729",
      id: "h-1729",
      inlines: [{ text: "§ 1729", type: "text" }],
      level: 3,
      plainText: "§ 1729",
      type: "heading",
    },
    paragraph("b-1", "par_1729-odst_1", wording),
    paragraph("b-2", "par_1729-odst_1-pism_a", `${wording} (a)`),
    paragraph("b-3", "par_1729-odst_2", "(2) Unrelated paragraph."),
  ],
});

type CitationSeed = {
  anchor: string;
  eli: string | null;
  spanStart: number;
  versionValidFrom?: string | null;
};

const citation = ({
  anchor,
  eli,
  spanStart,
  versionValidFrom = null,
}: CitationSeed) => ({
  anchor,
  jurisdiction: "CZE",
  spanStart,
  versionValidFrom,
  workEli: eli,
});

const pageOf = (
  rows: ReturnType<typeof citation>[],
): Page<ReturnType<typeof citation>> => ({
  items: rows,
  limit: 50,
  nextCursor: null,
});

const previewsFor = async (rows: ReturnType<typeof citation>[]) =>
  await attachDecisionProvisionPreviews({
    page: pageOf(rows),
    decisionDate: DECISION_DATE,
    legislationDb,
  });

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });

    legislationDb = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ): Promise<T> =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          // SAFETY: this PGlite transaction executes under the production
          // public-law role and exposes the same read surface to the callback.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for LegislationReadTransaction
          await fn(tx as unknown as LegislationReadTransaction),
      );

    await db.insert(legislationSources).values([
      { id: openSourceId, adapterKey: "statutes-open", name: "Open source" },
      {
        id: closedSourceId,
        adapterKey: "statutes-closed",
        name: "Withheld source",
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      },
    ]);

    await db.insert(legislationDocuments).values([
      {
        id: civilCodeOld,
        sourceId: openSourceId,
        eli: CIVIL_CODE_ELI,
        title: "Civil Code",
        country: "CZE",
        language: "cs",
        documentAst: statuteAst("(1) The wording in force in 2018."),
        versionValidFrom: "2014-01-01",
        versionValidTo: "2020-01-01",
      },
      {
        id: civilCodeCurrent,
        sourceId: openSourceId,
        eli: CIVIL_CODE_ELI,
        title: "Civil Code",
        country: "CZE",
        language: "cs",
        documentAst: statuteAst("(1) The wording in force today."),
        versionValidFrom: "2020-01-01",
        versionValidTo: null,
      },
      {
        id: withheldAct,
        sourceId: closedSourceId,
        eli: WITHHELD_ELI,
        title: "Withheld Act",
        country: "CZE",
        language: "cs",
        documentAst: statuteAst("(1) Not for redistribution."),
        versionValidFrom: "2014-01-01",
        versionValidTo: null,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client?.close();
});

describe("previews for a page of decision provision citations", () => {
  test("reads the wording in force when the decision was made", async () => {
    const { items, previews } = await previewsFor([
      citation({
        anchor: "par_1729-odst_1",
        eli: CIVIL_CODE_ELI,
        spanStart: 1,
      }),
    ]);

    expect(items.at(0)?.previewKey).not.toBeNull();
    expect(previews).toHaveLength(1);
    expect(previews.at(0)?.documentId).toBe(civilCodeOld);
    expect(previews.at(0)?.blocks.map(({ text }) => text)).toEqual([
      "(1) The wording in force in 2018.",
      "(1) The wording in force in 2018. (a)",
    ]);
  });

  test("a reference stating its own version overrides the decision date", async () => {
    const { previews } = await previewsFor([
      citation({
        anchor: "par_1729-odst_1",
        eli: CIVIL_CODE_ELI,
        spanStart: 1,
        versionValidFrom: "2020-01-01",
      }),
    ]);

    expect(previews.at(0)?.documentId).toBe(civilCodeCurrent);
  });

  test("one provision cited many times is read once", async () => {
    const { items, previews } = await previewsFor([
      citation({
        anchor: "par_1729-odst_1",
        eli: CIVIL_CODE_ELI,
        spanStart: 1,
      }),
      citation({
        anchor: "par_1729-odst_1",
        eli: CIVIL_CODE_ELI,
        spanStart: 9,
      }),
      citation({
        anchor: "par_1729-odst_2",
        eli: CIVIL_CODE_ELI,
        spanStart: 20,
      }),
    ]);

    expect(previews).toHaveLength(2);
    expect(items.at(0)?.previewKey).toBe(items.at(1)?.previewKey ?? null);
    expect(items.at(2)?.previewKey).not.toBe(items.at(0)?.previewKey ?? null);
  });

  test("every item's key names a preview the page carries", async () => {
    const { items, previews } = await previewsFor([
      citation({
        anchor: "par_1729-odst_1",
        eli: CIVIL_CODE_ELI,
        spanStart: 1,
      }),
      citation({
        anchor: "par_1729-odst_2",
        eli: CIVIL_CODE_ELI,
        spanStart: 9,
      }),
    ]);

    const keys = new Set(previews.map(({ key }) => key));

    expect(
      items.flatMap(({ previewKey }) =>
        previewKey === null || keys.has(previewKey) ? [] : [previewKey],
      ),
    ).toEqual([]);
  });

  test("a source not cleared for redistribution carries no wording", async () => {
    const { items, previews } = await previewsFor([
      citation({ anchor: "par_1729-odst_1", eli: WITHHELD_ELI, spanStart: 1 }),
    ]);

    expect(items.at(0)?.previewKey).toBeNull();
    expect(previews).toEqual([]);
  });

  test("a work the corpus does not hold carries no wording", async () => {
    const { items, previews } = await previewsFor([
      citation({ anchor: "par_1729-odst_1", eli: UNHELD_ELI, spanStart: 1 }),
      citation({ anchor: "par_1", eli: null, spanStart: 9 }),
    ]);

    expect(items.map(({ previewKey }) => previewKey)).toEqual([null, null]);
    expect(previews).toEqual([]);
  });

  test("an anchor the consolidation lost reads as an empty wording", async () => {
    const { items, previews } = await previewsFor([
      citation({ anchor: "par_9999", eli: CIVIL_CODE_ELI, spanStart: 1 }),
    ]);

    expect(items.at(0)?.previewKey).not.toBeNull();
    expect(previews.at(0)?.blocks).toEqual([]);
  });

  test("stops reading consolidations at the per-page ceiling", async () => {
    const overCeiling = Array.from(
      { length: LIMITS.caseLawProvisionPreviewVersionsMax + 2 },
      (_, index) =>
        citation({
          anchor: "par_1729-odst_1",
          eli: CIVIL_CODE_ELI,
          spanStart: index,
          // A distinct date per row is a distinct consolidation to resolve.
          versionValidFrom: `2020-01-${String(index + 1).padStart(2, "0")}`,
        }),
    );

    const { items } = await previewsFor(overCeiling);
    const previewed = items.filter(({ previewKey }) => previewKey !== null);

    expect(previewed).toHaveLength(LIMITS.caseLawProvisionPreviewVersionsMax);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { readProvisionPreviewHandler } from "@/api/handlers/legislation/provision-preview";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;

const openSourceId = createSafeId<"legislationSource">();
const closedSourceId = createSafeId<"legislationSource">();
const civilCode = createSafeId<"legislationDocument">();
const withheldAct = createSafeId<"legislationDocument">();

const heading = (id: string, anchorId: string, level: 1 | 2 | 3): Block => ({
  anchorId,
  id,
  inlines: [{ text: anchorId, type: "text" }],
  level,
  plainText: anchorId,
  type: "heading",
});

const paragraph = (id: string, anchorId: string, text: string): Block => ({
  anchorId,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

/**
 * One provision with subdivisions the way the corpus stores them: flat
 * paragraphs whose nesting lives in the anchor path, under the part and
 * chapter headings a preview quotes as context.
 */
const statuteAst = (): DocumentAst => ({
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
    heading("h-part", "cast_1", 1),
    heading("h-chapter", "hlava_2", 2),
    heading("h-898", "par_898", 3),
    paragraph("b-1", "par_898-odst_1", "(1) First paragraph."),
    paragraph("b-2", "par_898-odst_2", "(2) Second paragraph:"),
    paragraph("b-3", "par_898-odst_2-pism_a", "a) first letter,"),
    paragraph("b-4", "par_898-odst_2-pism_d", "d) fourth letter"),
    paragraph("b-5", "par_898-odst_2-pism_d-bod_1", "1. first point,"),
    paragraph("b-6", "par_898-odst_2-pism_d-bod_2", "2. second point."),
    paragraph("b-7", "par_898-odst_3", "(3) Third paragraph."),
    heading("h-899", "par_899", 3),
    paragraph("b-8", "par_899-odst_1", "(1) The next provision."),
  ],
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
        id: civilCode,
        sourceId: openSourceId,
        eli: "CZ/2012/89",
        title: "Civil Code",
        country: "CZE",
        language: "cs",
        documentAst: statuteAst(),
        versionValidFrom: "2020-01-01",
        versionValidTo: null,
      },
      {
        id: withheldAct,
        sourceId: closedSourceId,
        eli: "CZ/2020/123",
        title: "Withheld Act",
        country: "CZE",
        language: "cs",
        documentAst: statuteAst(),
        versionValidFrom: "2020-01-01",
        versionValidTo: null,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client?.close();
});

const readPreview = async (
  documentId: SafeId<"legislationDocument">,
  anchor: string,
  citedAnchor?: string,
) =>
  await readProvisionPreviewHandler({
    documentId,
    anchor,
    citedAnchor,
    legislationDb,
  });

type PreviewResult = Awaited<ReturnType<typeof readPreview>>;

const blockIds = (preview: PreviewResult): string[] => {
  if (!("blocks" in preview)) {
    throw new Error("expected a provision preview, not a status response");
  }
  return preview.blocks.map(({ id }) => id);
};

describe("reading one provision preview", () => {
  test("returns the provision body without the rest of the statute", async () => {
    const preview = await readPreview(civilCode, "par_898");

    expect(blockIds(preview)).toEqual([
      "b-1",
      "b-2",
      "b-3",
      "b-4",
      "b-5",
      "b-6",
      "b-7",
    ]);
  });

  test("quotes the headings the provision sits under", async () => {
    const preview = await readPreview(civilCode, "par_898");

    expect(
      "headings" in preview
        ? preview.headings.map(({ anchorId }) => anchorId)
        : null,
    ).toEqual(["cast_1", "hlava_2"]);
  });

  test("a cited paragraph keeps its letters and their points", async () => {
    const preview = await readPreview(civilCode, "par_898", "par_898-odst_2");

    expect(blockIds(preview)).toEqual(["b-2", "b-3", "b-4", "b-5", "b-6"]);
  });

  test("a cited letter keeps its points and stops at the next letter", async () => {
    const preview = await readPreview(
      civilCode,
      "par_898",
      "par_898-odst_2-pism_d",
    );

    expect(blockIds(preview)).toEqual(["b-4", "b-5", "b-6"]);
  });

  test("carries the language its text renders in", async () => {
    const preview = await readPreview(civilCode, "par_898");

    expect("language" in preview ? preview.language : null).toBe("cs");
  });

  test("an anchor the consolidation does not carry reads as not found", async () => {
    const preview = await readPreview(civilCode, "par_2079");

    expect(preview).not.toHaveProperty("blocks");
    expect(preview).toMatchObject({
      code: 404,
      response: { message: "Provision not found" },
    });
  });

  test("a source not cleared for redistribution reads as not found", async () => {
    const preview = await readPreview(withheldAct, "par_898");

    expect(preview).not.toHaveProperty("blocks");
    expect(preview).toMatchObject({
      code: 404,
      response: { message: "Legislation document not found" },
    });
  });
});

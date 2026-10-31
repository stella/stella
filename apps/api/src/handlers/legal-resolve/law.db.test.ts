import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  resolveCzechLaw,
  resolveSlovakLaw,
} from "@/api/handlers/legal-resolve/law";
import { createSafeId } from "@/api/lib/branded-types";
import { syncLegislationWorkNamesTx } from "@/api/lib/legal-search/legislation-work-names";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const ACTS = [
  {
    number: "513",
    year: "1991",
    collection: "Zb.",
    title: "Obchodný zákonník",
    shortTitle: "Obchodného zákonníka",
    wrongCollection: "Z. z.",
  },
  {
    number: "343",
    year: "2015",
    collection: "Z. z.",
    title: "Zákon o verejnom obstarávaní",
    shortTitle: "zákona o verejnom obstarávaní",
    wrongCollection: "Zb.",
  },
  {
    number: "187",
    year: "2021",
    collection: "Z. z.",
    title: "Zákon o ochrane hospodárskej súťaže",
    shortTitle: "zákona o ochrane hospodárskej súťaže",
    wrongCollection: "Zb.",
  },
].map((act) => ({
  ...act,
  eli: `https://www.slov-lex.sk/eli/sk/zz/${act.year}/${act.number}`,
  oldId: createSafeId<"legislationDocument">(),
  currentId: createSafeId<"legislationDocument">(),
}));

const sourceId = createSafeId<"legislationSource">();
const czechId = createSafeId<"legislationDocument">();
const czechEli = "https://www.e-sbirka.cz/eli/cz/sb/2012/89";
const TODAY = "2026-10-30";
const OLD_FROM = "2022-01-01";
const CURRENT_FROM = "2024-01-01";
const SECTION = "2";
const ANCHOR = "paragraf-2";
const SLOVAK_ANCHORS = {
  section: ANCHOR,
  subsection: `${ANCHOR}.odsek-1`,
  letter: `${ANCHOR}.odsek-1.pismeno-a`,
};

const statuteAst = (wording: string, anchors = SLOVAK_ANCHORS) =>
  ({
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
        type: "heading",
        id: "section-2",
        anchorId: anchors.section,
        level: 1,
        plainText: "§ 2",
        inlines: [{ type: "text", text: "§ 2" }],
      },
      {
        type: "paragraph",
        id: "subsection-1",
        anchorId: anchors.subsection,
        plainText: wording,
        inlines: [{ type: "text", text: wording }],
      },
      {
        type: "paragraph",
        id: "letter-a",
        anchorId: anchors.letter,
        plainText: "a) Prvá možnosť.",
        inlines: [{ type: "text", text: "a) Prvá možnosť." }],
      },
    ],
  }) satisfies DocumentAst;

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;

// timeout: PGlite schema bootstrap loads the migrated test snapshot.
beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  legislationDb = async (fn) =>
    await withPublicLawReaderRole(
      db,
      async (tx) => await fn(asTestRaw<LegislationReadTransaction>(tx)),
    );
  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "law-resolution-fixture",
    name: "Law resolution fixture",
  });
  const versions = ACTS.flatMap((act) => [
    {
      id: act.oldId,
      sourceId,
      eli: act.eli,
      title: act.title,
      country: "SVK",
      language: "sk",
      slug: `${act.number}-${act.year}`,
      versionValidFrom: OLD_FROM,
      versionValidTo: CURRENT_FROM,
      documentAst: statuteAst("Staršie znenie."),
    },
    {
      id: act.currentId,
      sourceId,
      eli: act.eli,
      title: act.title,
      country: "SVK",
      language: "sk",
      slug: `${act.number}-${act.year}`,
      versionValidFrom: CURRENT_FROM,
      versionValidTo: null,
      documentAst: statuteAst("Novšie znenie."),
    },
  ]);
  await db.insert(legislationDocuments).values(versions);
  await syncLegislationWorkNamesTx(asTestRaw(db), versions);
  await db.insert(legislationDocuments).values({
    id: czechId,
    sourceId,
    eli: czechEli,
    title: "89/2012 Sb., občanský zákoník",
    country: "CZE",
    language: "cs",
    slug: "89-2012-sb",
    versionValidFrom: CURRENT_FROM,
    documentAst: statuteAst("České znění.", {
      section: "par_2",
      subsection: "par_2-odst_1",
      letter: "par_2-odst_1-pism_a",
    }),
  });
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe("profile-driven law resolution over stored consolidations", () => {
  test.each(ACTS)(
    "$number/$year resolves text, structured identity and short titles",
    async (act) => {
      for (const input of [
        {
          citation: `§ 2 ods. 1 písm. a) zákona č. ${act.number}/${act.year} ${act.collection}`,
        },
        {
          citation: `§ 2 odsek 1 písmeno a) zákona č. ${act.number}/${act.year} ${act.collection}`,
        },
        {
          citation: `§ 2 ods. 1 písm. a) zákona č. ${act.number}/${act.year}`,
        },
        { collection: act.collection, number: act.number, year: act.year },
        { citation: `${act.number}/${act.year}` },
        { citation: act.title },
        { citation: `§ 2 ods. 1 písm. a) ${act.shortTitle}` },
      ]) {
        const result = await resolveSlovakLaw(
          { ...input, section: SECTION, asOf: TODAY },
          { legislationDb, today: () => TODAY },
        );
        expect(result).toMatchObject({
          status: "resolved",
          document: {
            kind: "provision",
            documentId: act.currentId,
            eli: act.eli,
            country: "SVK",
            title: act.title,
            section: SECTION,
            inForce: { from: CURRENT_FROM, to: null },
            versionStatus: "current",
            readerUrl: expect.stringContaining(`#${ANCHOR}`),
            blocks: expect.arrayContaining([
              expect.objectContaining({ text: "Novšie znenie." }),
            ]),
          },
        });
      }
    },
  );

  test.each(ACTS)(
    "$number/$year selects the consolidation in force on as_of",
    async (act) => {
      const result = await resolveSlovakLaw(
        {
          collection: act.collection,
          number: act.number,
          year: act.year,
          section: SECTION,
          asOf: "2023-06-01",
        },
        { legislationDb, today: () => TODAY },
      );
      expect(result).toMatchObject({
        status: "resolved",
        document: {
          documentId: act.oldId,
          inForce: { from: OLD_FROM, to: CURRENT_FROM },
          versionStatus: "outdated",
          readerUrl: expect.stringContaining(`/v/${OLD_FROM}#${ANCHOR}`),
          blocks: expect.arrayContaining([
            expect.objectContaining({ text: "Staršie znenie." }),
          ]),
        },
      });
    },
  );

  test.each(ACTS)(
    "$number/$year never resolves the other printed collection",
    async (act) => {
      for (const input of [
        {
          citation: `zákon č. ${act.number}/${act.year} ${act.wrongCollection}`,
        },
        { collection: act.wrongCollection, number: act.number, year: act.year },
      ]) {
        expect(
          await resolveSlovakLaw(
            { ...input, section: SECTION, asOf: TODAY },
            { legislationDb, today: () => TODAY },
          ),
        ).toMatchObject({
          status: "not_found",
          reason: "unknown_document",
          hint: expect.stringContaining(act.collection),
        });
      }
    },
  );

  test("distinguishes a missing act from a missing section in an existing act", async () => {
    expect(
      await resolveSlovakLaw(
        { citation: "99999/2021 Z. z.", section: SECTION, asOf: TODAY },
        { legislationDb, today: () => TODAY },
      ),
    ).toEqual({ status: "not_found", reason: "unknown_document" });
    expect(
      await resolveSlovakLaw(
        { citation: "513/1991 Zb.", section: "99999", asOf: TODAY },
        { legislationDb, today: () => TODAY },
      ),
    ).toEqual({ status: "not_found", reason: "unknown_section" });
  });

  test("the printed Slovak collection changes at the 1992/1993 boundary", async () => {
    for (const { year, expected, wrong } of [
      { year: "1992", expected: "Zb.", wrong: "Z. z." },
      { year: "1993", expected: "Z. z.", wrong: "Zb." },
    ]) {
      expect(
        await resolveSlovakLaw(
          { collection: expected, number: "99999", year, section: SECTION },
          { legislationDb, today: () => TODAY },
        ),
      ).toEqual({ status: "not_found", reason: "unknown_document" });
      expect(
        await resolveSlovakLaw(
          { collection: wrong, number: "99999", year, section: SECTION },
          { legislationDb, today: () => TODAY },
        ),
      ).toMatchObject({
        status: "not_found",
        reason: "unknown_document",
        hint: expect.stringContaining(expected),
      });
    }
  });

  test("Czech structured and short-title reads retain e-Sbírka anchors", async () => {
    for (const input of [
      { collection: "sb", number: "89", year: "2012" },
      { citation: "§ 2 občanského zákoníku" },
    ]) {
      expect(
        await resolveCzechLaw(
          { ...input, section: SECTION, asOf: TODAY },
          { legislationDb, today: () => TODAY },
        ),
      ).toMatchObject({
        status: "resolved",
        document: {
          documentId: czechId,
          eli: czechEli,
          country: "CZE",
          readerUrl: expect.stringContaining("#par_2"),
        },
      });
    }
  });
});

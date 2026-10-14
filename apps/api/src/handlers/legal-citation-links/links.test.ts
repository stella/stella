import { panic } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { legalCitationLinksHandler } from "@/api/handlers/legal-citation-links/links";
import { createSafeId } from "@/api/lib/branded-types";
import { buildCaseLawDecisionAppUrl } from "@/api/lib/legal-search/public-law-app-urls";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { createTestState } from "@/api/tests/helpers/test-state";

// Decision citations link by exact identity only: a docket that names one
// decision links to it, and one that may name several stays plain text.

const testState = createTestState({ file: import.meta.path, config: env });

beforeEach(() => testState.setConfig("FEATURE_PUBLIC_LAW", true));

const NO_STATUTE_READ: LegislationReadDb = async () =>
  await Promise.resolve(panic("A text without statutes reads no statute"));

const row = ({
  caseNumber,
  ecli,
  court = "Nejvyšší správní soud",
}: {
  caseNumber: string;
  ecli: string | null;
  court?: string;
}) =>
  ({
    id: createSafeId<"caseLawDecision">(),
    caseNumber,
    caseNumberType: "case-number",
    country: "CZE",
    court,
    courtAbbreviation: null,
    decisionDate: "2008-10-30",
    ecli,
    identifiers: [],
    language: "cs",
    languageAlternates: [],
    slug: null,
  }) satisfies DecisionIdentityRow;

const NSS_DECISION = row({
  caseNumber: "3 Afs 41/2008 - 98",
  ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.98",
});

const linksIn = async (text: string, rows: readonly DecisionIdentityRow[]) =>
  (
    await legalCitationLinksHandler(
      { text, asOf: "2025-03-01", countries: ["CZE"] },
      {
        legislationDb: NO_STATUTE_READ,
        lookup: async () => await Promise.resolve([...rows]),
      },
    )
  ).links;

describe("decision citation links", () => {
  test.each([
    ["Soud odkázal na ECLI:CZ:NSS:2008:3.AFS.41.2008.98.", NSS_DECISION.ecli],
    [
      "Viz rozsudek č. j. 3 Afs 41/2008 - 98 a další.",
      "č. j. 3 Afs 41/2008 - 98",
    ],
  ])("links %p to the one decision it names", async (text, cited) => {
    const links = await linksIn(text, [NSS_DECISION]);
    expect(links.map(({ start, end }) => text.slice(start, end))).toEqual([
      cited,
    ]);
    expect(links[0]?.kind).toBe("decision");
    expect(links[0]?.url).toBe(
      buildCaseLawDecisionAppUrl({
        caseNumber: NSS_DECISION.caseNumber,
        country: NSS_DECISION.country,
        court: NSS_DECISION.court,
        decisionId: NSS_DECISION.id,
        language: NSS_DECISION.language,
        languageAlternates: NSS_DECISION.languageAlternates,
        slug: NSS_DECISION.slug,
      }),
    );
  });

  test("every occurrence of a resolved citation is linked", async () => {
    const text =
      "Rozsudek č. j. 3 Afs 41/2008 - 98 je klíčový; č. j. 3 Afs 41/2008 - 98 to potvrzuje.";
    const links = await linksIn(text, [NSS_DECISION]);
    expect(links).toHaveLength(2);
    expect(new Set(links.map(({ url }) => url)).size).toBe(1);
  });

  const fileDecision = ({
    caseNumber,
    court,
    decisionDate,
  }: {
    caseNumber: string;
    court: string;
    decisionDate: string;
  }) => ({ ...row({ caseNumber, ecli: null, court }), decisionDate });

  const linkedDecisionIds = async (
    text: string,
    rows: readonly DecisionIdentityRow[],
  ) => {
    const urlById = new Map(
      rows.map((decision) => [
        buildCaseLawDecisionAppUrl({
          caseNumber: decision.caseNumber,
          country: decision.country,
          court: decision.court,
          decisionId: decision.id,
          language: decision.language,
          languageAlternates: decision.languageAlternates,
          slug: decision.slug,
        }),
        decision.id,
      ]),
    );
    return (await linksIn(text, rows)).map(({ url }) => urlById.get(url));
  };

  describe.each([
    {
      docket: "21 Cdo 4733/2015",
      court: "Nejvyšší soud",
      cited: (date: string) =>
        date === ""
          ? "Nejvyšší soud ve věci sp. zn. 21 Cdo 4733/2015 uvedl…"
          : `Nejvyšší soud v rozsudku ze dne ${date}, sp. zn. 21 Cdo 4733/2015, uvedl…`,
    },
    {
      docket: "Pl. ÚS 1/20",
      court: "Ústavní soud",
      cited: (date: string) =>
        date === ""
          ? "Ústavní soud v nálezu sp. zn. Pl. ÚS 1/20 uvedl…"
          : `Ústavní soud v nálezu ze dne ${date}, sp. zn. Pl. ÚS 1/20, uvedl…`,
    },
  ])("a bare docket $docket", ({ docket, court, cited }) => {
    const first = fileDecision({
      caseNumber: docket,
      court,
      decisionDate: "2017-02-01",
    });
    const second = fileDecision({
      caseNumber: docket,
      court,
      decisionDate: "2018-06-12",
    });

    test("links the file's only decision", async () => {
      expect(await linkedDecisionIds(cited(""), [first])).toEqual([first.id]);
    });

    test("links the decision dated as the text dates it", async () => {
      expect(
        await linkedDecisionIds(cited("12. 6. 2018"), [first, second]),
      ).toEqual([second.id]);
    });

    test("stays plain when the file holds several and no date picks one", async () => {
      expect(await linkedDecisionIds(cited(""), [first, second])).toEqual([]);
    });

    test("stays plain when the written date matches none of them", async () => {
      expect(
        await linkedDecisionIds(cited("3. 3. 2019"), [first, second]),
      ).toEqual([]);
    });
  });

  test("an ambiguous or unknown citation stays plain text", async () => {
    const text = "Viz rozsudek č. j. 3 Afs 41/2008 - 98.";
    const twin = { ...NSS_DECISION, id: createSafeId<"caseLawDecision">() };
    expect(await linksIn(text, [NSS_DECISION, twin])).toEqual([]);
    expect(await linksIn(text, [])).toEqual([]);
  });

  test("text without citations makes no lookup", async () => {
    const { links } = await legalCitationLinksHandler(
      { text: "Žádná citace.", asOf: "2025-03-01", countries: ["CZE"] },
      {
        legislationDb: NO_STATUTE_READ,
        lookup: async () =>
          await Promise.resolve(panic("No citation, no identity lookup")),
      },
    );
    expect(links).toEqual([]);
  });
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { env } from "@/api/env";
import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { legalCitationLinksHandler } from "@/api/handlers/legal-citation-links/links";
import type { LegalCitationLink } from "@/api/handlers/legal-citation-links/links";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { createTestState } from "@/api/tests/helpers/test-state";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

// The linker reads the same corpus the statute reader serves: a provision
// links to the consolidation in force on the answer's date, and a work the
// corpus does not hold stays plain text.

const LABOUR_CODE_ELI = "https://www.e-sbirka.cz/eli/cz/sb/2006/262";
const CHARTER_ELI = "https://www.e-sbirka.cz/eli/cz/sb/1993/2";

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;
const testState = createTestState({ file: import.meta.path, config: env });

beforeEach(() => testState.setConfig("FEATURE_PUBLIC_LAW", true));

const sourceId = createSafeId<"legislationSource">();
const labourCode2007 = createSafeId<"legislationDocument">();
const labourCode2024 = createSafeId<"legislationDocument">();
const charter = createSafeId<"legislationDocument">();

const NO_DECISIONS = async (): Promise<DecisionIdentityRow[]> =>
  await Promise.resolve([]);

testState.beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  await db.execute(sql.raw("SET TIME ZONE 'UTC'"));
  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "citation-links-open",
    name: "Open statutes source",
  });
  const row = ({
    id,
    eli,
    slug,
    from,
    to,
  }: {
    id: SafeId<"legislationDocument">;
    eli: string;
    slug: string;
    from: string;
    to: string | null;
  }) => ({
    id,
    sourceId,
    eli,
    slug,
    title: `Act ${slug}`,
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "current",
    versionValidFrom: from,
    versionValidTo: to,
    expressionKind: "consolidation" as const,
    windowDisposition: "effective" as const,
    windowDispositionBasis: null,
  });
  await db.insert(legislationDocuments).values([
    row({
      id: labourCode2007,
      eli: LABOUR_CODE_ELI,
      slug: "zakonik-prace",
      from: "2007-01-01",
      to: "2023-12-31",
    }),
    row({
      id: labourCode2024,
      eli: LABOUR_CODE_ELI,
      slug: "zakonik-prace",
      from: "2024-01-01",
      to: null,
    }),
    row({
      id: charter,
      eli: CHARTER_ELI,
      slug: "listina",
      from: "1993-01-01",
      to: null,
    }),
  ]);

  legislationDb = async (read) =>
    await withPublicLawReaderRole(
      db,
      async (tx) =>
        // SAFETY: this PGlite transaction executes under the production
        // public-law role and exposes the same read surface to the callback.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for LegislationReadTransaction
        await read(tx as unknown as LegislationReadTransaction),
    );
});

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

const linksIn = async (
  text: string,
  asOf = "2025-03-01",
): Promise<LegalCitationLink[]> =>
  (
    await legalCitationLinksHandler(
      { text, asOf, countries: ["CZE"] },
      { legislationDb, lookup: NO_DECISIONS },
    )
  ).links;

const linkedText = (text: string, links: readonly LegalCitationLink[]) =>
  links.map(({ start, end }) => text.slice(start, end));

describe("statute citation links", () => {
  test.each([
    [
      "Podle § 106 odst. 4 písm. e) zákona č. 262/2006 Sb. musí zaměstnanec…",
      "§ 106 odst. 4 písm. e) zákona č. 262/2006 Sb.",
    ],
    [
      "Výpověď podle § 55 odst. 1 písm. b) ZP je okamžitým zrušením.",
      "§ 55 odst. 1 písm. b) ZP",
    ],
    [
      "Důvod podle § 52 písm. g) zákoníku práce nastal.",
      "§ 52 písm. g) zákoníku práce",
    ],
    [
      "Duvod podle § 52 pism. g) zakoniku prace nastal.",
      "§ 52 pism. g) zakoniku prace",
    ],
    ["Chrání ho čl. 10 Listiny.", "čl. 10 Listiny"],
  ])("links %p", async (text, cited) => {
    const links = await linksIn(text);
    expect(linkedText(text, links)).toEqual([cited]);
    expect(links[0]?.kind).toBe("statute");
  });

  test("links each of several provisions in one answer to its own act", async () => {
    const text =
      "Srovnej § 52 písm. g) ZP a čl. 10 Listiny, jakož i § 55 odst. 1 ZP.";
    const links = await linksIn(text);
    expect(linkedText(text, links)).toEqual([
      "§ 52 písm. g) ZP",
      "čl. 10 Listiny",
      "§ 55 odst. 1 ZP",
    ]);
    expect(links.map(({ url }) => url.includes("listina"))).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("a range, a list or an act the corpus does not hold stays plain text", async () => {
    for (const text of [
      "Podle § 316 odst. 2 a 3 ZP.",
      "Podle § 5 zákona č. 999/2099 Sb.",
      "Podle § 52 bez uvedení předpisu.",
    ]) {
      expect(await linksIn(text)).toEqual([]);
    }
  });

  test("the link opens the consolidation in force on the answer's date", async () => {
    const text = "Podle § 52 písm. g) ZP.";
    const [current] = await linksIn(text, "2025-03-01");
    const [older] = await linksIn(text, "2020-06-15");
    expect(current?.url).toContain("2024-01-01");
    expect(older?.url).toContain("2007-01-01");
    expect(older?.url).not.toBe(current?.url);
  });

  test("the text a link covers is never rewritten", async () => {
    const text = "Viz § 55 odst. 1 písm. b) ZP.";
    const links = await linksIn(text);
    for (const { start, end } of links) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(text.length);
    }
    expect(text).toBe("Viz § 55 odst. 1 písm. b) ZP.");
  });

  test("a country without a profile links nothing", async () => {
    const { links } = await legalCitationLinksHandler(
      {
        text: "Podle § 52 písm. g) ZP.",
        asOf: "2025-03-01",
        countries: ["DEU"],
      },
      { legislationDb, lookup: NO_DECISIONS },
    );
    expect(links).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import section51StatuteAst from "@stll/legal-ast/fixtures/cz-262-2006-section-51" with { type: "json" };

import {
  caseLawFtsConfigs,
  legislationDocuments,
  legislationFacetCounts,
  legislationSearchDocuments,
  legislationWorkNames,
} from "@/api/db/schema";
import { resetLocalCaseLawConfigForTesting } from "@/api/lib/case-law/local-case-law-config";
import { readNamedLegislationWorks } from "@/api/lib/legal-search/legislation-work-names";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { seedLegislation, SECTION_51_VERSION_DATE } from "./seed-legislation";

test("local seeding creates searchable Czech statute versions and converges on replay", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await db
    .insert(caseLawFtsConfigs)
    .values({ language: "cs", regconfig: "simple", useUnaccent: false })
    .onConflictDoUpdate({
      target: caseLawFtsConfigs.language,
      set: { regconfig: "simple", useUnaccent: false },
    });
  resetLocalCaseLawConfigForTesting(db);
  const scopedDb = executeRowsScopedDb(
    async (run) => await db.transaction(run),
  );
  try {
    await seedLegislation(scopedDb);
    await seedLegislation(scopedDb);
    const rows = await db.select().from(legislationDocuments);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(({ eli }) => eli))).toEqual(
      new Set(["/eli/cz/sb/2012/89", "/eli/cz/sb/2006/262"]),
    );
    for (const eli of new Set(rows.map((row) => row.eli))) {
      const versions = rows.filter((row) => row.eli === eli);
      expect(
        new Set(versions.map(({ versionValidFrom }) => versionValidFrom)),
      ).toEqual(
        new Set(
          eli === "/eli/cz/sb/2006/262"
            ? ["2020-01-01", SECTION_51_VERSION_DATE]
            : ["2020-01-01", "2024-01-01"],
        ),
      );
      expect(
        versions.every(
          ({ publisherExpressionId, slug }) =>
            publisherExpressionId !== null && slug !== null,
        ),
      ).toBe(true);
    }
    const currentWorkVersion = rows.find(
      ({ eli, versionValidFrom }) =>
        eli === "/eli/cz/sb/2006/262" &&
        versionValidFrom === SECTION_51_VERSION_DATE,
    );
    const historicalWorkVersion = rows.find(
      ({ eli, versionValidFrom }) =>
        eli === "/eli/cz/sb/2006/262" && versionValidFrom === "2020-01-01",
    );
    expect(currentWorkVersion?.documentAst).toEqual(section51StatuteAst);
    expect(currentWorkVersion?.effectiveDate).toBe(SECTION_51_VERSION_DATE);
    expect(currentWorkVersion?.fulltext).toBe(
      section51StatuteAst.blocks.map(({ plainText }) => plainText).join("\n\n"),
    );
    expect(historicalWorkVersion?.versionValidTo).toBe(SECTION_51_VERSION_DATE);
    expect(await db.select().from(legislationSearchDocuments)).toHaveLength(4);
    const named = await scopedDb(async (tx) =>
      readNamedLegislationWorks(tx, { query: "89/2012", country: "CZE" }),
    );
    expect(named).toHaveLength(1);
    expect(named.at(0)?.eli).toBe("/eli/cz/sb/2012/89");
    expect(
      (await db.select().from(legislationWorkNames)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(await db.select().from(legislationFacetCounts)).toEqual([
      expect.objectContaining({
        country: "CZE",
        works: 2,
        documentType: "act",
      }),
    ]);
  } finally {
    resetLocalCaseLawConfigForTesting();
    await client.close();
  }
}, 120_000);

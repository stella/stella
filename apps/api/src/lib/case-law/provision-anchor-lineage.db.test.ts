import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { PROVISION_CITATION_GRAMMARS } from "@stll/legal-atlas/provision-citation-grammars";
import {
  assertProperty,
  propertyConfig,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  provisionAnchorLineage,
  provisionAnchorLineageSql,
  provisionAnchorSubtreeSql,
} from "@/api/lib/case-law/provision-anchor-lineage";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);
afterAll(async () => await client.close());

/** Every grammar's jurisdiction; one outside them is a bug the owner panics on. */
const JURISDICTIONS = Object.keys(PROVISION_CITATION_GRAMMARS);

/**
 * Anchors over every separator a grammar uses, characters either side of
 * them in byte order, and a non-ASCII letter, so empty segments, doubled
 * separators and near-miss prefixes all occur.
 */
const anchorArbitrary = fc
  .array(
    fc.constantFrom("par_", "odst_", "5", "1", "a", "č", "-", ".", ",", "/"),
    {
      maxLength: 8,
    },
  )
  .map((parts) => parts.join(""));

const storedLineage = async (jurisdiction: string, anchor: string) => {
  const result = await db.execute<{ lineage: string[] }>(
    sql`SELECT ${provisionAnchorLineageSql(sql`${jurisdiction}`, sql`${anchor}`)} AS lineage`,
  );
  return result.rows.at(0)?.lineage;
};

test("a section anchor reaches its subdivisions and no longer section", async () => {
  expect(
    provisionAnchorLineage({
      jurisdiction: "CZE",
      anchor: "par_51-odst_3-pism_a",
    }),
  ).toEqual(["par_51", "par_51-odst_3", "par_51-odst_3-pism_a"]);
  expect(await storedLineage("CZE", "par_51-odst_3-pism_a")).toEqual([
    "par_51",
    "par_51-odst_3",
    "par_51-odst_3-pism_a",
  ]);
  const rows = await db.execute<{ anchor: string }>(sql`
    SELECT candidate.anchor FROM (VALUES
      ('par_5'), ('par_51'), ('par_51-odst_1'), ('par_51-odst_3-pism_a'),
      ('par_510'), ('par_51a'), ('par_52'), ('par_5-odst_1')
    ) AS candidate(anchor)
    WHERE ${provisionAnchorSubtreeSql(sql.raw("candidate.anchor"), {
      jurisdiction: "CZE",
      anchor: "par_51",
    })}
    ORDER BY candidate.anchor COLLATE "C"
  `);
  expect(rows.rows.map(({ anchor }) => anchor)).toEqual([
    "par_51",
    "par_51-odst_1",
    "par_51-odst_3-pism_a",
  ]);
});

test(
  "the stored lineage and the subtree read agree with the TypeScript owner",
  async () => {
    await assertProperty(
      "the stored lineage and the subtree read agree with the TypeScript owner",
      fc.asyncProperty(
        fc.constantFrom(...JURISDICTIONS),
        anchorArbitrary,
        anchorArbitrary,
        async (jurisdiction, anchor, probe) => {
          const lineage = provisionAnchorLineage({ jurisdiction, anchor });
          expect(await storedLineage(jurisdiction, anchor)).toEqual(lineage);
          // Probe both an unrelated anchor and each provision above this one.
          for (const target of [probe, ...lineage]) {
            if (target === "") {
              continue;
            }
            const result = await db.execute<{ inside: boolean }>(
              sql`SELECT ${provisionAnchorSubtreeSql(sql`${anchor}::text`, {
                jurisdiction,
                anchor: target,
              })} AS inside`,
            );
            expect(result.rows.at(0)?.inside).toBe(lineage.includes(target));
          }
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  },
  propertyTestTimeout(60_000),
);

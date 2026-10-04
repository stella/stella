import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

import {
  assertScaleProfileApplied,
  estimateHeapFetches,
  injectScaleProfile,
  SYNTHETIC_SCALE_PROFILE,
} from "./scale-profile";

const ROW_COUNT = 1000;
const TEST_TIMEOUT_MS = 120_000;

const planNodes = (
  node: Record<string, unknown>,
): Record<string, unknown>[] => {
  const children = node["Plans"];
  if (children === undefined) {
    return [node];
  }
  if (!Array.isArray(children) || !children.every(isRecord)) {
    return panic("Malformed child plans in scale test");
  }
  return [node, ...children.flatMap(planNodes)];
};

const explainNodes = async (
  db: { execute: (query: SQL) => PromiseLike<unknown> },
  query: SQL,
): Promise<Record<string, unknown>[]> => {
  const row = executedRows(
    await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`),
  ).at(0);
  const document = isRecord(row) ? row["QUERY PLAN"] : undefined;
  const first = Array.isArray(document) ? document.at(0) : undefined;
  const root = isRecord(first) ? first["Plan"] : undefined;
  if (!isRecord(root)) {
    return panic("Scale test could not decode EXPLAIN JSON");
  }
  return planNodes(root);
};

test(
  "synthetic catalog stats produce large estimates, keep physical pages, and expose a later ANALYZE",
  async () => {
    const client = new PGlite();
    try {
      const db = drizzle({ client });
      const physicalPages = new Map<string, number>();
      for (const table of Object.keys(SYNTHETIC_SCALE_PROFILE.tables)) {
        await db.execute(sql`
          CREATE TABLE ${sql.identifier(table)} (
            id uuid PRIMARY KEY, country varchar(3), language varchar(8),
            type varchar(32), ecli text, language_group_key text,
            case_number text, decision_id uuid, normalized_value text,
            slug text, eli text, docket_family_key text
          )
        `);
        await db.execute(sql`
          INSERT INTO ${sql.identifier(table)}
            (id, country, language, type, ecli, language_group_key,
             case_number, decision_id, normalized_value, slug, eli,
             docket_family_key)
          SELECT
            ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
            CASE n % 3 WHEN 0 THEN 'CZE' WHEN 1 THEN 'SVK' ELSE 'POL' END,
            CASE n % 4 WHEN 0 THEN 'cs' WHEN 1 THEN 'sk'
              WHEN 2 THEN 'pl' ELSE 'en' END,
            CASE n % 4 WHEN 0 THEN 'ecli' WHEN 1 THEN 'case-number'
              WHEN 2 THEN 'neutral-citation' ELSE 'reporter-citation' END,
            CASE WHEN n % 7 = 0 THEN NULL
              ELSE 'ECLI:EU:C:2024:' || (n % 120)::text END,
            'qpg-language-group-' || (n % 180)::text,
            'qpg-case-' || n::text,
            ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
            CASE WHEN n % 4 = 0 THEN 'eclieuc2024' || (n % 120)::text
              ELSE 'other' END,
            'qpg-slug-' || n::text,
            '/eli/cz/sb/2024/' || n::text,
            CASE WHEN n % 2 = 0 THEN NULL
              ELSE 'qpg-family-' || (n % 90)::text END
          FROM generate_series(1, ${ROW_COUNT}) AS series(n)
        `);
        await db.execute(sql`ANALYZE ${sql.identifier(table)}`);
        const row = executedRows(
          await db.execute(sql`
            SELECT relpages FROM pg_class WHERE oid = ${table}::regclass
          `),
        ).at(0);
        if (!isRecord(row) || typeof row["relpages"] !== "number") {
          panic(`Missing physical page count for ${table}`);
        }
        physicalPages.set(table, row["relpages"]);
      }
      await db.execute(sql`
        CREATE INDEX case_law_decisions_country_idx
          ON case_law_decisions (country)
      `);
      await db.execute(sql`
        CREATE INDEX case_law_decisions_ecli_idx
          ON case_law_decisions (ecli)
      `);
      await db.execute(sql`
        CREATE INDEX case_law_decision_identifiers_lookup_idx
          ON case_law_decision_identifiers (type, normalized_value, decision_id)
      `);

      await injectScaleProfile(db, SYNTHETIC_SCALE_PROFILE);
      await assertScaleProfileApplied(db, SYNTHETIC_SCALE_PROFILE);
      for (const [table, profile] of Object.entries(
        SYNTHETIC_SCALE_PROFILE.tables,
      )) {
        const row = executedRows(
          await db.execute(sql`
            SELECT relpages, reltuples, relallvisible
              FROM pg_class WHERE oid = ${table}::regclass
          `),
        ).at(0);
        if (!isRecord(row)) {
          panic(`Missing restored stats for ${table}`);
        }
        expect(row["relpages"]).toBe(physicalPages.get(table));
        expect(row["reltuples"]).toBeGreaterThanOrEqual(profile.reltuples);
        expect(row["relallvisible"]).toBe(
          Math.round(
            (physicalPages.get(table) ?? 0) * profile.allVisibleFraction,
          ),
        );
        const nodes = await explainNodes(
          db,
          sql`SELECT count(*) FROM ${sql.identifier(table)}`,
        );
        expect(
          nodes.some(
            (node) =>
              typeof node["Plan Rows"] === "number" &&
              node["Plan Rows"] >= profile.reltuples,
          ),
        ).toBe(true);
      }

      const countryStats = executedRows(
        await db.execute(sql`
          SELECT null_frac, n_distinct, most_common_vals::text AS values
            FROM pg_stats
           WHERE schemaname = 'public'
             AND tablename = 'case_law_decisions'
             AND attname = 'country'
        `),
      ).at(0);
      expect(countryStats).toMatchObject({
        null_frac: 0,
        n_distinct: 3,
        values: "{CZE,SVK,POL}",
      });
      for (const [table, column, expected] of [
        ["case_law_decisions", "ecli", -0.8],
        ["case_law_decisions", "language_group_key", -0.4],
        ["case_law_decisions", "case_number", -0.9],
        ["case_law_decision_identifiers", "normalized_value", -0.9],
        ["legislation_documents", "slug", -1],
        ["legislation_documents", "eli", -1],
      ] as const) {
        const row = executedRows(
          await db.execute(sql`
            SELECT n_distinct, most_common_vals::text AS values
              FROM pg_stats
             WHERE schemaname = 'public'
               AND tablename = ${table}
               AND attname = ${column}
          `),
        ).at(0);
        if (!isRecord(row)) {
          panic(`Missing synthetic column stats for ${table}.${column}`);
        }
        expect(row["n_distinct"]).toBeCloseTo(expected);
        const commonValues = row["values"];
        expect(commonValues === null || commonValues === "{}").toBe(true);
      }

      const oldNodes = await explainNodes(
        db,
        sql`
        SELECT d.id FROM case_law_decisions AS d
         WHERE d.country = 'CZE'
           AND (d.ecli IN ('ECLI:EU:C:2024:12') OR d.id IN (
             SELECT i.decision_id FROM case_law_decision_identifiers AS i
              WHERE i.type = 'ecli' AND i.normalized_value = 'eclieuc202412'
           ))
         LIMIT 50
      `,
      );
      expect(
        oldNodes.some(
          (node) =>
            typeof node["Filter"] === "string" &&
            node["Filter"].includes(" OR ") &&
            node["Filter"].includes("SubPlan"),
        ),
      ).toBe(true);

      const unionNodes = await explainNodes(
        db,
        sql`
        SELECT d.id FROM (
          SELECT id FROM case_law_decisions WHERE ecli IN ('ECLI:EU:C:2024:12')
          UNION ALL
          SELECT decision_id AS id FROM case_law_decision_identifiers
           WHERE type = 'ecli' AND normalized_value = 'eclieuc202412'
        ) AS candidates
        JOIN case_law_decisions AS d ON d.id = candidates.id
       WHERE d.country = 'CZE'
       LIMIT 50
      `,
      );
      const indexes = unionNodes.flatMap((node) =>
        typeof node["Index Name"] === "string" ? [node["Index Name"]] : [],
      );
      expect(indexes).toContain("case_law_decisions_ecli_idx");
      expect(indexes).toContain("case_law_decision_identifiers_lookup_idx");
      expect(
        unionNodes.some(
          (node) =>
            typeof node["Filter"] === "string" &&
            node["Filter"].includes("SubPlan"),
        ),
      ).toBe(false);

      await db.execute(sql`ANALYZE case_law_decisions`);
      const overwritten = await assertScaleProfileApplied(
        db,
        SYNTHETIC_SCALE_PROFILE,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(overwritten).toMatchObject({
        message:
          "Scale profile was overwritten or not applied: case_law_decisions",
      });
    } finally {
      await client.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test("heap-fetch estimates use the guarded relation's visibility fraction", () => {
  expect(
    estimateHeapFetches(
      {
        nodeType: "Index Only Scan",
        relation: "case_law_citations",
        rows: 1000,
      },
      SYNTHETIC_SCALE_PROFILE,
    ),
  ).toBe(800);
  expect(
    estimateHeapFetches(
      {
        nodeType: "Index Only Scan",
        relation: "case_law_decisions",
        rows: 1000,
      },
      SYNTHETIC_SCALE_PROFILE,
    ),
  ).toBe(500);
  expect(
    estimateHeapFetches(
      { nodeType: "Index Scan", relation: "case_law_decisions", rows: 1000 },
      SYNTHETIC_SCALE_PROFILE,
    ),
  ).toBeNull();
});

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  caseLawFilterMembershipQuery,
  readCaseLawFilterScope,
} from "@/api/lib/case-law/filter-country-scope";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";

const sourceId = createSafeId<"caseLawSource">();
const missingSourceId = createSafeId<"caseLawSource">();
let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
});

afterAll(async () => {
  await client.close();
});

test("decision type syntax validation requires no corpus read", async () => {
  const filters = { type: "foreign-type" };
  const read = await readCaseLawFilterScope({
    country: "CZE",
    filters,
    caseLawDb: asTestRaw(async () => {
      throw new Error("Unexpected corpus read");
    }),
  });
  expect(read).toEqual({ filters, removed: [] });
});

test("blank filters require no corpus read and are absent", async () => {
  expect(
    await readCaseLawFilterScope({
      country: "CZE",
      filters: { court: "", lang: "", type: "" },
      caseLawDb: asTestRaw(async () => {
        throw new Error("Unexpected corpus read");
      }),
    }),
  ).toEqual({ filters: {}, removed: [] });
});

test("published membership retains country filters and removes only a foreign value", async () => {
  const domesticSourceId = createSafeId<"caseLawSource">();
  const foreignSourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values([
    caseLawSourceRow({
      id: domesticSourceId,
      adapterKey: "membership-domestic",
    }),
    caseLawSourceRow({
      id: foreignSourceId,
      adapterKey: "membership-foreign",
    }),
  ]);
  await db.insert(caseLawDecisions).values([
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId: domesticSourceId,
      caseNumber: "1 Cdo 1/2026",
      country: "CZE",
      court: "Membership Czech court",
      language: "cs",
      metadata: {},
    },
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId: foreignSourceId,
      caseNumber: "1 Cdo 2/2026",
      country: "SVK",
      court: "Membership Slovak court",
      language: "sk",
      metadata: {},
    },
  ]);
  const readDb = async <T>(
    read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(
      db,
      async (roleTx) =>
        await read(asTestRaw<CaseLawPublicReadTransaction>(roleTx)),
    );
  const caseLawDb = asTestRaw<CaseLawPublicReadDb>(readDb);
  const filters = {
    court: "Membership Czech court",
    lang: "cs",
    sourceId: domesticSourceId,
  };
  expect(
    await readCaseLawFilterScope({ country: "CZE", filters, caseLawDb }),
  ).toEqual({
    filters,
    removed: [],
  });
  for (const [field, value, countries] of [
    ["court", "Membership Slovak court", ["SVK"]],
    ["lang", "sk", []],
    ["sourceId", foreignSourceId, []],
  ] as const) {
    const retained = Object.fromEntries(
      Object.entries(filters).filter(([key]) => key !== field),
    );
    expect(
      await readCaseLawFilterScope({
        country: "CZE",
        filters: { ...filters, [field]: value },
        caseLawDb,
      }),
    ).toEqual({
      filters: retained,
      removed: [{ field, value, countries: [...countries] }],
    });
  }
});

test("membership probes retain indexed plans without type indexes at N and 10N", async () => {
  let previousRows = 0;
  for (const rows of [1200, 12_000]) {
    await db.execute(sql`
      INSERT INTO case_law_decisions (id, source_id, case_number, country, court, language, metadata)
      SELECT gen_random_uuid(), ${sourceId}::uuid, i::text, 'CZE', 'Bulk court', 'cs', '{}'
      FROM generate_series(${previousRows + 1}::integer, ${rows}::integer) i
    `);
    previousRows = rows;
    await db.execute(sql`ANALYZE case_law_decisions`);
    for (const probe of [
      {
        field: "court",
        value: "Absent court",
        column: "court",
      },
      {
        field: "lang",
        value: "zz",
        column: "language",
      },
      {
        field: "sourceId",
        value: missingSourceId,
        column: "source_id",
      },
    ] as const) {
      await withPublicLawReaderRole(db, async (roleTx) => {
        const tx = asTestRaw<CaseLawPublicReadTransaction>(roleTx);
        const query = caseLawFilterMembershipQuery({
          tx,
          country: "CZE",
          ...probe,
        });
        const scans = scanOccurrences(
          explainRoot(
            await roleTx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`),
          ),
        );
        const decisions = scans.filter(
          ({ relation }) => relation === "case_law_decisions",
        );
        expect(decisions).toHaveLength(1);
        const decisionScan = decisions.at(0);
        expect(decisionScan?.nodeType).toBe("Index Scan");
        expect(
          decisionScan?.indexCond
            ?.replaceAll(/[()]/gu, "")
            .replaceAll("::text", ""),
        ).toContain(`${probe.column} =`);
        await roleTx.execute(sql`SET LOCAL enable_indexscan = off`);
        await roleTx.execute(sql`SET LOCAL enable_bitmapscan = off`);
        const mutated = scanOccurrences(
          explainRoot(
            await roleTx.execute(sql`EXPLAIN (FORMAT JSON) ${query}`),
          ),
        );
        expect(
          mutated.some(
            ({ relation, nodeType }) =>
              relation === "case_law_decisions" && nodeType === "Seq Scan",
          ),
        ).toBe(true);
        expect(await query).toEqual([]);
      });
    }
  }
});

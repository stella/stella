import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { readAdmittedCourtPage } from "@/api/handlers/case-law/decisions/shelf-courts";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { CASE_LAW_COURT_CATALOG_TOOL_SET } from "@/api/mcp/case-law-court-catalog-tool";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

/** The page the scaling case reads, at both fixture sizes. */
export const COURT_CATALOG_SCALING_PAGE = 10;

const sourceIdFor = (size: number) =>
  `01990000-00c5-7000-8000-${size.toString(16).padStart(12, "0")}`;

/** A country per fixture size, so the two sizes never read each other's courts. */
const countryFor = (size: number) =>
  `XR${String.fromCodePoint(65 + (Math.floor(size / 10) % 26))}`;

/**
 * One page of a country's courts while the country holds as many courts as
 * the fixture holds rows: the page, its statements and its bytes stay the
 * same whatever the country holds.
 */
export const measureCourtCatalogTool = async (fixture: ReadFixture) => {
  const { db, size } = fixture;
  const sourceId = sourceIdFor(size);
  const country = countryFor(size);
  await db.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name, enabled)
    VALUES (${sourceId}::uuid, 'court-catalog-scaling', 'Court catalog scaling', false)
    ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO case_law_population_counts
    (kind, country, source_id, value, total)
    SELECT 'court', ${country}, ${sourceId}::uuid,
      'Scaling court ' || lpad(n::text, 5, '0'), 1
    FROM generate_series(1, ${size}) n
    ON CONFLICT DO NOTHING`);
  try {
    // The fixture's transaction supplies the select surface the reader uses.
    const caseLawDb = asTestRaw<CaseLawPublicReadDb>(
      async <Value>(
        read: (tx: CaseLawPublicReadTransaction) => Promise<Value>,
      ) =>
        await db.transaction(
          async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
        ),
    );
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response =
        await CASE_LAW_COURT_CATALOG_TOOL_SET.handlers.list_case_law_courts({
          args: { country, limit: COURT_CATALOG_SCALING_PAGE },
          context: asTestRaw<
            Parameters<
              typeof CASE_LAW_COURT_CATALOG_TOOL_SET.handlers.list_case_law_courts
            >[0]["context"]
          >({
            testDependencies: {
              readAdmittedCaseLawCourtPage: async (request: {
                country: string;
                after: string | null;
                limit: number;
              }) =>
                await readAdmittedCourtPage({
                  caseLawDb,
                  excludedSourceIds: [],
                  ...request,
                }),
            },
          }),
        });
      if (
        !("egress" in response) ||
        response.egress !== "structured" ||
        !isRecord(response.payload) ||
        !isUnknownArray(response.payload["courts"])
      ) {
        return panic(
          "list_case_law_courts scaling requires a successful egress payload",
        );
      }
      const rows = response.payload["courts"].reduce<number>(
        (sum, tier) =>
          sum +
          (isRecord(tier) && isUnknownArray(tier["courts"])
            ? tier["courts"].length
            : 0),
        0,
      );
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response.payload)),
        rows,
      };
    });
  } finally {
    await db.execute(
      sql`DELETE FROM case_law_population_counts WHERE source_id = ${sourceId}::uuid`,
    );
    await db.execute(
      sql`DELETE FROM case_law_sources WHERE id = ${sourceId}::uuid`,
    );
  }
};

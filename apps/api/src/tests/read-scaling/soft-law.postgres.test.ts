import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  readSoftLawDocument,
  searchSoftLawDocuments,
} from "@/api/lib/legal-search/soft-law-read";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { readScalingViolations } from "./measurement";
import {
  softLawReadScalingScenario,
  softLawSearchScalingScenario,
} from "./soft-law";

type Measured = Awaited<
  ReturnType<(typeof softLawReadScalingScenario)["measure"]>
>;

const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "regulator guidance scaling",
  () => {
    const compare = (
      name: string,
      rows: number,
      small: Measured,
      large: Measured,
    ) => {
      console.info(
        "handler-scaling",
        JSON.stringify({ name, at10: small, at200: large }),
      );
      expect(small.rows).toBe(rows);
      expect(large.rows).toBe(rows);
      expect(small.statements).toBeGreaterThan(0);
      expect(small.transactionRoundTrips).toBeGreaterThan(0);
      expect(readScalingViolations({ small, large })).toEqual([]);
    };

    test("search stays bounded as the corpus grows", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const read = searchSoftLawDocuments;
        compare(
          softLawSearchScalingScenario.name,
          10,
          await softLawSearchScalingScenario.measure({ size: 10, db, read }),
          await softLawSearchScalingScenario.measure({ size: 200, db, read }),
        );
      });
    });

    test("read stays bounded as the corpus grows", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const read = readSoftLawDocument;
        compare(
          softLawReadScalingScenario.name,
          1,
          await softLawReadScalingScenario.measure({ size: 10, db, read }),
          await softLawReadScalingScenario.measure({ size: 200, db, read }),
        );
      });
    });
  },
);

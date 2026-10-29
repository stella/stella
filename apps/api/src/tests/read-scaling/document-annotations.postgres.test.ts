import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

import {
  documentAnnotationScalingScenarios,
  seedDocumentAnnotationScaling,
} from "./document-annotations";
import { readScalingViolations } from "./measurement";

/** Every scenario on one fresh document of `size` marks, list first. */
const measureAt = async (db: GatedTestDb, size: number) => {
  const fakeS3 = startFakeS3();
  const fixture = await seedDocumentAnnotationScaling({ db, fakeS3, size });
  try {
    const measurements = [];
    for (const scenario of documentAnnotationScalingScenarios) {
      measurements.push(await scenario.measure(fixture));
    }
    return measurements;
  } finally {
    await fixture.cleanup();
    fakeS3.stop();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "document annotation scaling",
  () => {
    test("each document mark route pays the same round trips at 10 and 200 marks", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const small = await measureAt(db, 10);
        const large = await measureAt(db, 200);
        for (const [
          index,
          scenario,
        ] of documentAnnotationScalingScenarios.entries()) {
          expect(
            apiApp.routes.some(
              ({ definition }) => definition === scenario.definition,
            ),
          ).toBe(true);
          const at10 = small.at(index) ?? panic(`${scenario.name}: unmeasured`);
          const at200 =
            large.at(index) ?? panic(`${scenario.name}: unmeasured`);
          console.info(
            "handler-scaling",
            JSON.stringify({ name: scenario.name, at10, at200 }),
          );
          expect(at10.rows).toBe(scenario.expectedRows);
          expect(at200.rows).toBe(scenario.expectedRows);
          expect(at10.statements).toBeGreaterThan(0);
          expect(at10.transactionRoundTrips).toBeGreaterThan(0);
          expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        }
      });
    }, 180_000); // timeout: seeds 210 marks, each one reading and parsing the PDF
  },
);

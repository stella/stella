import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiRoutes } from "@/api/api-routes";
import { dictationVocabularyTerms } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  dictationVocabularyScalingScenarios,
  seedDictationVocabularyScaling,
} from "@/api/tests/read-scaling/dictation-vocabulary";
import { createScalingTempTables } from "@/api/tests/read-scaling/entity-fixture";
import {
  readScalingViolations,
  writeScalingViolations,
} from "@/api/tests/read-scaling/measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "organization dictation words scaling",
  () => {
    test("every mounted handler stays bounded as other organizations' words grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await createScalingTempTables(db, [dictationVocabularyTerms]);
        const fixtures = [];
        try {
          fixtures.push(await seedDictationVocabularyScaling(db, 10));
          fixtures.push(await seedDictationVocabularyScaling(db, 200));
          const small = fixtures.at(0) ?? panic("Small fixture required");
          const large = fixtures.at(1) ?? panic("Large fixture required");
          for (const scenario of dictationVocabularyScalingScenarios) {
            const mounted = apiRoutes.filter(
              ({ definition }) => definition === scenario.definition,
            );
            expect(mounted).toHaveLength(1);
            const at10 = await scenario.measure(small);
            const at200 = await scenario.measure(large);
            console.info(
              "handler-scaling",
              JSON.stringify({ name: scenario.name, at10, at200 }),
            );
            expect(at10.statements).toBeGreaterThan(0);
            expect(
              readScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
            expect(
              writeScalingViolations({ small: at10, large: at200 }),
            ).toEqual([]);
          }
        } finally {
          for (const fixture of fixtures) {
            await fixture.cleanup();
          }
        }
      });
    });
  },
);

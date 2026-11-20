import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { apiRoutes } from "@/api/api-routes";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { createScalingTempTables } from "@/api/tests/read-scaling/entity-fixture";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  seedSkillExportScaling,
  skillExportScalingScenario,
} from "@/api/tests/read-scaling/skill-export";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "skill archive export scaling",
  () => {
    test("reads only the exported skill across tenant cardinalities", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        await createScalingTempTables(db, [agentSkills, agentSkillResources]);
        const fixtures = [];
        try {
          fixtures.push(await seedSkillExportScaling(db, 10));
          fixtures.push(await seedSkillExportScaling(db, 200));
          const small = fixtures.at(0) ?? panic("Small fixture required");
          const large = fixtures.at(1) ?? panic("Large fixture required");
          expect(
            apiRoutes.filter(
              ({ definition }) =>
                definition === skillExportScalingScenario.definition,
            ),
          ).toHaveLength(1);
          const at10 = await skillExportScalingScenario.measure(small);
          const at200 = await skillExportScalingScenario.measure(large);
          console.info(
            "handler-scaling",
            JSON.stringify({
              name: skillExportScalingScenario.name,
              at10,
              at200,
            }),
          );
          expect(at10.statements).toBeGreaterThan(0);
          expect(readScalingViolations({ small: at10, large: at200 })).toEqual(
            [],
          );
        } finally {
          for (const fixture of fixtures) {
            await fixture.cleanup();
          }
        }
      });
    });
  },
);

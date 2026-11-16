import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createBrowseCalendarRoute } from "@/api/handlers/case-law/decisions/browse-calendar";
import { createBrowseCourtsRoute } from "@/api/handlers/case-law/decisions/browse-courts";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  browseCalendarScalingScenario,
  browseCourtsScalingScenario,
} from "./case-law-browse-hubs";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "public case-law browse hub scaling",
  () => {
    test("the court calendar reads the same as other courts grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const small = await browseCalendarScalingScenario.measure({
          size: 10,
          db: openClient().db,
          createHandler: createBrowseCalendarRoute,
        });
        const large = await browseCalendarScalingScenario.measure({
          size: 200,
          db: openClient().db,
          createHandler: createBrowseCalendarRoute,
        });
        expect(small.rows).toBe(1);
        expect(large.rows).toBe(1);
        expect(readScalingViolations({ small, large })).toEqual([]);
      });
    });

    test("the court list reads the same as other jurisdictions grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const small = await browseCourtsScalingScenario.measure({
          size: 10,
          db: openClient().db,
          createHandler: createBrowseCourtsRoute,
        });
        const large = await browseCourtsScalingScenario.measure({
          size: 200,
          db: openClient().db,
          createHandler: createBrowseCourtsRoute,
        });
        expect(small.rows).toBe(3);
        expect(large.rows).toBe(3);
        expect(readScalingViolations({ small, large })).toEqual([]);
      });
    });
  },
);

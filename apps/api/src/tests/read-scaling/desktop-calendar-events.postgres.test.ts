import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { env } from "@/api/env";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import {
  DESKTOP_CALENDAR_SCALING_EVENTS,
  desktopCalendarEventsScalingScenario as scenario,
  seedDesktopCalendarEventsScaling,
} from "./desktop-calendar-events";
import { readScalingViolations } from "./measurement";

const testState = createTestState({ file: import.meta.path, config: env });

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "desktop calendar events scaling",
  () => {
    test("a linked desktop's calendar day reads the same among 10 and 200 other connections", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      expect(
        apiApp.routes.some(
          ({ definition }) => definition === scenario.definition,
        ),
      ).toBe(true);
      testState.patchConfig({
        FEATURE_SHAREPOINT: true,
        FEATURE_TIME_BILLING: true,
      });
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const measureAt = async (size: number) => {
          const fixture = await seedDesktopCalendarEventsScaling(db, size);
          try {
            return await scenario.measure(fixture);
          } finally {
            await fixture.cleanup();
          }
        };
        const small = await measureAt(10);
        const large = await measureAt(200);
        // Prague's local day, read once per request whatever the population.
        const day = {
          start: "2026-10-01T22:00:00Z",
          end: "2026-10-02T22:00:00Z",
        };
        for (const measured of [small, large]) {
          expect(measured.graphReads).toEqual([day]);
          expect(measured.response).toEqual({
            status: "ready",
            events: [...DESKTOP_CALENDAR_SCALING_EVENTS],
            truncated: false,
          });
        }
        expect(small.statements).toBeGreaterThan(0);
        expect(small.transactionRoundTrips).toBeGreaterThan(0);
        expect(readScalingViolations({ small, large })).toEqual([]);
        console.info(
          "handler-scaling",
          JSON.stringify({ name: scenario.name, small, large }),
        );
      });
    }, 120_000); // timeout: seeds and reads real PostgreSQL connections at two populations
  },
);

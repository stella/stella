import { panic } from "better-result";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { parseMigrationDrainConfirmation } from "../env-migration";
import {
  assertMigrationCutover,
  MigrationSchedulerDrainRequired,
} from "./migration-cutover";
import type { MigrationCutoverEvent } from "./migration-cutover";

const automatic = { type: "automatic" } as const;

test.each([
  {
    name: "fresh database without scheduler storage",
    responses: [
      [{ jobsExist: false, runsExist: false, activityExists: false }],
    ],
    outcome: "admitted",
  },
  {
    name: "idle scheduler storage without execution records",
    responses: [
      [{ jobsExist: true, runsExist: true, activityExists: false }],
      [{ uncovered: false }],
    ],
    outcome: "admitted",
  },
  {
    name: "an uncovered execution refuses despite other covered executions",
    responses: [
      [{ jobsExist: true, runsExist: true, activityExists: true }],
      [{ uncovered: true }],
    ],
    outcome: "refused",
  },
  {
    name: "an uncovered recent run refuses without claim storage",
    responses: [
      [{ jobsExist: false, runsExist: true, activityExists: false }],
      [{ uncovered: true }],
    ],
    outcome: "refused",
  },
  {
    name: "all relevant executions are covered regardless of claim age",
    responses: [
      [{ jobsExist: true, runsExist: true, activityExists: true }],
      [{ uncovered: false }],
    ],
    outcome: "admitted",
  },
])("$name", async ({ responses, outcome }) => {
  let reads = 0;
  const admission = assertMigrationCutover({
    connection: {
      query: async () =>
        responses.at(reads++) ?? panic("Unexpected admission read"),
    },
    tables: ["scheduler_jobs"],
    confirmation: automatic,
  });
  if (outcome === "refused") {
    expect(await rejectionOf(admission)).toBeInstanceOf(
      MigrationSchedulerDrainRequired,
    );
  } else {
    await admission;
  }
  expect(reads).toBe(responses.length);
});

test("manual admission requires the typed reason and records only that check's confirmation", async () => {
  const events: MigrationCutoverEvent[] = [];
  let reads = 0;
  await assertMigrationCutover({
    connection: {
      query: async () => {
        reads++;
        return [];
      },
    },
    tables: ["scheduler_jobs"],
    confirmation: parseMigrationDrainConfirmation(
      "Workers drained for isolated maintenance",
    ).unwrap(),
    emit: (event) => events.push(event),
  });
  expect(reads).toBe(0);
  expect(events).toEqual([
    {
      event: "migrate.manual_drain_confirmed",
      reason: "Workers drained for isolated maintenance",
      tableCount: 1,
    },
  ]);
});

test("a pending union without relation locks needs neither activity nor confirmation", async () => {
  let reads = 0;
  await assertMigrationCutover({
    connection: {
      query: async () => {
        reads++;
        return [];
      },
    },
    tables: [],
    confirmation: automatic,
  });
  expect(reads).toBe(0);
});

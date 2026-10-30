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
    name: "fresh database without scheduler tables",
    responses: [[{ jobsExist: false, activityExists: false }]],
    outcome: "admitted",
  },
  {
    name: "scheduler tables without recent work",
    responses: [
      [{ jobsExist: true, activityExists: false }],
      [{ active: false }],
    ],
    outcome: "admitted",
  },
  {
    name: "recent work without table leases",
    responses: [
      [{ jobsExist: true, activityExists: false }],
      [{ active: true }],
    ],
    outcome: "refused",
  },
  {
    name: "recent work with an expired lease watermark",
    responses: [
      [{ jobsExist: true, activityExists: true }],
      [{ active: true }],
      [{ recent: false }],
    ],
    outcome: "refused",
  },
  {
    name: "recent work with recent table leases",
    responses: [
      [{ jobsExist: true, activityExists: true }],
      [{ active: true }],
      [{ recent: true }],
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

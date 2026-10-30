import { panic } from "better-result";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { parseMigrationDrainConfirmation } from "../env-migration";
import {
  assertMigrationCutover,
  MigrationSchedulerDrainRequired,
} from "./migration-cutover";
import type { MigrationCutoverEvent } from "./migration-cutover";
import { TABLE_LEASE_PROTOCOL } from "./table-lease-protocol";

const automatic = { type: "automatic" } as const;

test.each([
  {
    name: "a fresh database bootstraps protocol activation",
    responses: [[{ markerExists: false, jobsExist: false }]],
    tables: ["scheduler_jobs"],
    outcome: "bootstrapped",
  },
  {
    name: "an empty scheduler table bootstraps protocol activation",
    responses: [
      [{ markerExists: false, jobsExist: true }],
      [{ hasHistory: false }],
    ],
    tables: ["scheduler_jobs"],
    outcome: "bootstrapped",
  },
  {
    name: "empty protocol storage and no scheduler history bootstraps",
    responses: [
      [{ markerExists: true, jobsExist: true }],
      [{ live: false }],
      [{ hasHistory: false }],
    ],
    tables: [],
    outcome: "bootstrapped",
  },
  {
    name: "scheduler history without protocol storage requires a manual drain",
    responses: [
      [{ markerExists: false, jobsExist: true }],
      [{ hasHistory: true }],
    ],
    tables: ["scheduler_jobs"],
    outcome: "refused",
  },
  {
    name: "scheduler history and an empty marker table requires a manual drain",
    responses: [
      [{ markerExists: true, jobsExist: true }],
      [{ live: false }],
      [{ hasHistory: true }],
    ],
    tables: [],
    outcome: "refused",
  },
  {
    name: "the exact protocol marker admits locking migrations",
    responses: [[{ markerExists: true, jobsExist: true }], [{ live: true }]],
    tables: ["scheduler_jobs"],
    outcome: "admitted",
  },
  {
    name: "the exact protocol marker admits an empty lock union",
    responses: [[{ markerExists: true, jobsExist: false }], [{ live: true }]],
    tables: [],
    outcome: "admitted",
  },
])("$name", async ({ responses, tables, outcome }) => {
  let reads = 0;
  let bootstraps = 0;
  const events: MigrationCutoverEvent[] = [];
  const admission = assertMigrationCutover({
    connection: {
      query: async () =>
        responses.at(reads++) ?? panic("Unexpected protocol admission read"),
    },
    tables,
    confirmation: automatic,
    bootstrapProtocol: async () => {
      bootstraps++;
    },
    emit: (event) => events.push(event),
  });
  if (outcome === "refused") {
    const error = await rejectionOf(admission);
    expect(error).toBeInstanceOf(MigrationSchedulerDrainRequired);
    expect(error).toMatchObject({
      message: expect.stringMatching(/manual.*drain/iu),
    });
  } else {
    await admission;
  }
  expect(reads).toBe(responses.length);
  expect(bootstraps).toBe(outcome === "bootstrapped" ? 1 : 0);
  expect(events).toEqual(
    outcome === "bootstrapped"
      ? [
          {
            event: "migrate.table_lease_protocol_bootstrapped",
            protocol: TABLE_LEASE_PROTOCOL,
            tableCount: tables.length,
          },
        ]
      : [],
  );
});

test.each([{ tables: [] }, { tables: ["scheduler_jobs"] }])(
  "typed manual confirmation records its reason for lock union $tables",
  async ({ tables }) => {
    const events: MigrationCutoverEvent[] = [];
    let reads = 0;
    await assertMigrationCutover({
      connection: {
        query: async () => {
          reads++;
          return [];
        },
      },
      tables,
      confirmation: parseMigrationDrainConfirmation(
        "Workers drained for isolated maintenance",
      ).unwrap(),
      bootstrapProtocol: async () =>
        panic("Manual confirmation must not bootstrap the protocol"),
      emit: (event) => events.push(event),
    });
    expect(reads).toBe(0);
    expect(events).toEqual([
      {
        event: "migrate.manual_drain_confirmed",
        reason: "Workers drained for isolated maintenance",
        tableCount: tables.length,
      },
    ]);
  },
);

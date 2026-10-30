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

test("locking migrations refuse without recent lease-aware admission", async () => {
  expect(
    await rejectionOf(
      assertMigrationCutover({
        connection: { query: async () => [{ exists: false }] },
        tables: ["scheduler_jobs"],
        confirmation: automatic,
      }),
    ),
  ).toBeInstanceOf(MigrationSchedulerDrainRequired);
});

test.each([true, false])(
  "recent lease-aware claim admission is %s",
  async (recent) => {
    const responses = [[{ exists: true }], [{ recent }]];
    let reads = 0;
    const admission = assertMigrationCutover({
      connection: {
        query: async () =>
          responses.at(reads++) ?? panic("Unexpected admission read"),
      },
      tables: ["scheduler_jobs"],
      confirmation: automatic,
    });
    if (recent) {
      await admission;
    } else {
      expect(await rejectionOf(admission)).toBeInstanceOf(
        MigrationSchedulerDrainRequired,
      );
    }
    expect(reads).toBe(2);
  },
);

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

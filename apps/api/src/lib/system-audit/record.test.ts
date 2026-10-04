import { expect, test } from "bun:test";

import { systemAuditRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  SYSTEM_ACTOR_PATTERN,
  SYSTEM_RUN_ACTOR_COUNTS,
  TENANT_SYSTEM_ACTOR,
} from "./actors";
import { recordSystemAudit, systemAuditRow } from "./record";

const RUN_ID = toSafeId<"schedulerJobRun">(
  "0192f1d2-0000-7000-8000-000000000001",
);

const recordingDb = () => {
  const inserts: { table: unknown; row: unknown }[] = [];
  const db = asTestRaw<SchedulerDb>({
    insert: (table: unknown) => ({
      values: async (row: unknown) => {
        inserts.push({ table, row });
      },
    }),
  });
  return { db, inserts };
};

test("a run that changed something records one row with its actor, run and counts", async () => {
  const { db, inserts } = recordingDb();

  expect(
    await recordSystemAudit(db, "system:registration-retention", {
      subject: RUN_ID,
      counts: {
        verifications: 2,
        assertions: 0,
        replays: 0,
        registrations: 1,
        clients: 1,
        budgets: 0,
      },
    }),
  ).toBe(true);

  expect(inserts).toEqual([
    {
      table: systemAuditRuns,
      row: {
        id: expect.any(String),
        actor: "system:registration-retention",
        subject: RUN_ID,
        counts: {
          verifications: 2,
          assertions: 0,
          replays: 0,
          registrations: 1,
          clients: 1,
          budgets: 0,
        },
      },
    },
  ]);
});

test("a run that changed nothing records nothing", async () => {
  const { db, inserts } = recordingDb();

  expect(
    await recordSystemAudit(db, "system:file-comparison-sweep", {
      subject: RUN_ID,
      counts: { sweptUploads: 0 },
    }),
  ).toBe(false);
  expect(inserts).toEqual([]);
});

test.each([
  ["a negative count", { sweptUploads: -1 }],
  ["a fractional count", { sweptUploads: 1.5 }],
  ["an undeclared count", { sweptUploads: 1, extra: 1 }],
  ["a missing count", {}],
])("%s is refused before anything is written", (_label, counts) => {
  expect(() =>
    systemAuditRow("system:file-comparison-sweep", {
      subject: RUN_ID,
      counts: asTestRaw<{ sweptUploads: number }>(counts),
    }),
  ).toThrow("system:file-comparison-sweep counts");
});

test("every system actor id has the shape the database accepts", () => {
  const ids = [
    ...Object.keys(SYSTEM_RUN_ACTOR_COUNTS),
    ...Object.values(TENANT_SYSTEM_ACTOR),
  ];
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) {
    expect(id).toMatch(SYSTEM_ACTOR_PATTERN);
  }
  for (const counts of Object.values(SYSTEM_RUN_ACTOR_COUNTS)) {
    expect(counts.length).toBeGreaterThan(0);
    expect(new Set(counts).size).toBe(counts.length);
  }
});

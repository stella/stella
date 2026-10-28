import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createMigrationLockTelemetry,
  migrationQueryFingerprint,
  observeMigrationLockAttempt,
} from "./migration-lock-observation";
import type { MigrationLockEvent } from "./migration-lock-observation";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const recordingTelemetry = () => {
  const records: MigrationLockEvent[] = [];
  const telemetry = createMigrationLockTelemetry();
  telemetry.emit = (record) => {
    records.push(record);
  };
  return { records, telemetry };
};

describe("migration query fingerprints", () => {
  test("normalizes SQL and removes literals, parameters and quoted identifiers before truncation", () => {
    expect(
      migrationQueryFingerprint(
        `SELECT "Probe", 'sample', 42, 1.25e-8, $1, true, NULL FROM public.probe\n WHERE id = 7`,
      ),
    ).toBe('select "?", ?, ?, ?, ?, ?, ? from public.probe where id = ?');
    expect(
      migrationQueryFingerprint(
        "SELECT 'it''s a value', E'one\\'two', $tag$body$tag$, $$text$$",
      ),
    ).toBe("select ?, e?, ?, ?");
    expect(
      migrationQueryFingerprint("SELECT 0xFF, 0o17, 0b10, 1_000.25_0"),
    ).toBe("select ?, ?, ?, ?");
    expect(migrationQueryFingerprint('SELECT "a""b" FROM "Probe"')).toBe(
      'select "?" from "?"',
    );
    expect(migrationQueryFingerprint(`SELECT '${"sample".repeat(1000)}'`)).toBe(
      "select ?",
    );
    expect(
      migrationQueryFingerprint(`SELECT ${"column_name, ".repeat(100)}`),
    ).toHaveLength(256);
    expect(
      migrationQueryFingerprint(
        "SELECT /* outer /* inner */ tail */ 1 -- note\n FROM probe",
      ),
    ).toBe("select ? from probe");
  });
});

test("fingerprints discard every PostgreSQL Unicode dollar-quote tag", () => {
  const nonAscii = fc
    .oneof(
      fc.integer({ min: 0x80, max: 0xd7_ff }),
      fc.integer({ min: 0xe0_00, max: 0x10_ff_ff }),
    )
    .map((codePoint) => String.fromCodePoint(codePoint));
  const tag = fc
    .tuple(
      nonAscii,
      fc.array(fc.oneof(nonAscii, fc.constantFrom("a", "Z", "_", "0", "9")), {
        maxLength: 8,
      }),
    )
    .map(([first, rest]) => first + rest.join(""));
  assertProperty(
    "fingerprints discard every PostgreSQL Unicode dollar-quote tag",
    fc.property(tag, (delimiter) => {
      expect(
        migrationQueryFingerprint(
          `SELECT $${delimiter}$SensitiveValue ' /* body */ $${delimiter}$`,
        ),
      ).toBe("select ?");
    }),
    { numRuns: 200 },
  );
  for (const delimiter of ["täg", "tag\u0301", "😀", "العربية", "_tag9"]) {
    expect(
      migrationQueryFingerprint(
        `SELECT $${delimiter}$SensitiveValue$${delimiter}$`,
      ),
    ).toBe("select ?");
  }
});

test("a deferred online attempt and a failed schema attempt each emit one terminal event with retries spent", async () => {
  const { records, telemetry } = recordingTelemetry();
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => [
      {
        mode: "AccessExclusiveLock",
        tableName: "probe",
        statement: "ALTER TABLE probe ADD COLUMN n integer",
        pid: 12,
        state: "idle in transaction",
        xactAgeMs: 5000,
        waitEvent: "ClientRead",
        query: "UPDATE probe SET n = 42",
      },
    ],
    release: () => undefined,
  };
  const observe = async (
    phase: "schema" | "online",
    work: () => Promise<"deferred" | "done">,
  ) =>
    await observeMigrationLockAttempt({
      observer,
      pid: 11,
      phase,
      step: "probe",
      table: "probe",
      telemetry,
      work,
      outcome: (result) => result,
    });
  await observe("online", async () => "deferred");
  records.length = 0;
  await observe("online", async () => "deferred");
  expect(records).toHaveLength(1);
  expect(records.at(0)).toMatchObject({
    event: "migrate.lock_attempt",
    phase: "online",
    step: "probe",
    table: "probe",
    statementClass: "alter",
    lockMode: "AccessExclusiveLock",
    attempt: 2,
    retriesSpent: 1,
    outcome: "deferred",
    waits: [
      expect.objectContaining({
        table: "probe",
        statementClass: "alter",
        lockMode: "AccessExclusiveLock",
        waitMs: expect.any(Number),
        blockers: [
          expect.objectContaining({
            pid: 12,
            queryFingerprint: "update probe set n = ?",
          }),
        ],
      }),
    ],
    blockers: [
      {
        pid: 12,
        state: "idle in transaction",
        xactAgeMs: 5000,
        waitEvent: "ClientRead",
        queryFingerprint: "update probe set n = ?",
      },
    ],
  });
  const failure = new Error("schema attempt failed");
  const fail = async (): Promise<"done"> => {
    throw failure;
  };
  expect(await rejectionOf(observe("schema", fail))).toBe(failure);
  records.length = 0;
  expect(await rejectionOf(observe("schema", fail))).toBe(failure);
  expect(records).toHaveLength(1);
  expect(records.at(0)).toMatchObject({
    phase: "schema",
    outcome: "failed",
    attempt: 2,
    retriesSpent: 1,
  });
  expect(telemetry.retriesSpent).toBe(2);
});

test("successful work resets the step's retry sequence", async () => {
  const { records, telemetry } = recordingTelemetry();
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => [],
    release: () => undefined,
  };
  for (const outcome of ["deferred", "done", "done"] as const) {
    await observeMigrationLockAttempt({
      observer,
      pid: 11,
      phase: "online",
      step: "probe",
      table: "probe",
      telemetry,
      work: async () => outcome,
      outcome: (result) => result,
    });
  }
  expect(records.map(({ attempt }) => attempt)).toEqual([1, 2, 1]);
  expect(records.at(-1)).toMatchObject({
    waitMs: 0,
    lockMode: null,
    blockers: [],
  });
});

test("observer failure cancels pending work and emits one failed attempt", async () => {
  const { records, telemetry } = recordingTelemetry();
  const pending = Promise.withResolvers<"done">();
  const failure = new Error("observation unavailable");
  let cancellations = 0;
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => {
      throw failure;
    },
    release: () => undefined,
  };
  const result = await rejectionOf(
    observeMigrationLockAttempt({
      observer,
      pid: 11,
      phase: "schema",
      step: "schema.preflight",
      table: null,
      telemetry,
      work: async () => await pending.promise,
      outcome: () => "done",
      cancelWork: async () => {
        cancellations += 1;
        pending.resolve("done");
      },
    }),
  );
  expect(result).toMatchObject({ cause: failure });
  expect(cancellations).toBe(1);
  expect(records).toHaveLength(1);
  expect(records.at(0)).toMatchObject({ outcome: "failed", retriesSpent: 0 });
});

test("observer failure after completed work does not cancel the committed session", async () => {
  const { records, telemetry } = recordingTelemetry();
  const query = Promise.withResolvers<readonly unknown[]>();
  const workCompleted = Promise.withResolvers<undefined>();
  const failure = new Error("late observation failure");
  let cancellations = 0;
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => await query.promise,
    release: () => undefined,
  };
  const observation = observeMigrationLockAttempt({
    observer,
    pid: 11,
    phase: "schema",
    step: "schema.pending",
    table: null,
    telemetry,
    work: async () => {
      workCompleted.resolve(undefined);
      return true;
    },
    outcome: () => "done",
    cancelWork: async () => {
      cancellations += 1;
    },
  });

  await workCompleted.promise;
  query.reject(failure);

  expect(await rejectionOf(observation)).toMatchObject({ cause: failure });
  expect(cancellations).toBe(0);
  expect(records).toHaveLength(1);
  expect(records.at(0)).toMatchObject({ outcome: "failed" });
});

test("statement retries join deferred attempts and reset after successful work", async () => {
  const { records, telemetry } = recordingTelemetry();
  const observer: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async () => [],
    release: () => undefined,
  };
  const rounds = [
    { retries: 3, outcome: "deferred" },
    { retries: 1, outcome: "done" },
    { retries: 0, outcome: "done" },
  ] as const;
  for (const round of rounds) {
    let retries = 0;
    await observeMigrationLockAttempt({
      observer,
      pid: 11,
      phase: "online",
      step: "probe",
      table: "probe",
      telemetry,
      additionalRetries: () => retries,
      work: async () => {
        retries = round.retries;
        return round.outcome;
      },
      outcome: (result) => result,
    });
  }
  expect(
    records.map(({ attempt, retriesSpent }) => ({ attempt, retriesSpent })),
  ).toEqual([
    { attempt: 4, retriesSpent: 3 },
    { attempt: 6, retriesSpent: 5 },
    { attempt: 1, retriesSpent: 0 },
  ]);
  expect(telemetry.retriesSpent).toBe(5);
});

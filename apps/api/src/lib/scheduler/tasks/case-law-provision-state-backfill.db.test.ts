import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { setTimeout as sleepWithSignal } from "node:timers/promises";

import type { Verdict } from "@stll/db-load-gate/health";
import {
  PROVISION_EXTRACTION_ADMISSION,
  PROVISION_EXTRACTION_ADMISSION_REVISION,
} from "@stll/legal-atlas/provision-extraction-admission";

import { BackfillFailedError } from "@/api/db/backfill-runtime";
import type { withLongRunningConnection } from "@/api/db/long-running-connection";
import { ProvisionBackfillUnitError } from "@/api/lib/case-law/provision-state-backfill/step";
import { logger } from "@/api/lib/observability/logger";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { createCaseLawProvisionStateBackfillTask } from "./case-law-provision-state-backfill";

let client: Awaited<ReturnType<typeof createTestPglite>>;

beforeAll(async () => {
  client = await createTestPglite();
  const constraints = (
    await client.query<{ name: string }>(
      "SELECT conname AS name FROM pg_constraint WHERE conrelid = 'public.case_law_provision_citations'::regclass AND contype = 'c' AND NOT convalidated",
    )
  ).rows;
  for (const { name } of constraints) {
    await client.query(
      `ALTER TABLE public.case_law_provision_citations VALIDATE CONSTRAINT "${name.replaceAll('"', '""')}"`,
    );
  }
}, 120_000);
afterAll(async () => await client.close());

// The fixture begins after admission reconciliation; both empty keyset walks
// still run through the real task, real steps and durable runtime transactions.
beforeEach(async () => {
  await client.query("DELETE FROM database_backfill_states");
  await client.query("DELETE FROM case_law_provision_repair_cursors");
  await client.query("DELETE FROM case_law_provision_scope_transitions");
  await client.query(
    "INSERT INTO case_law_provision_admission AS admission (key, revision) VALUES ('global', $1) ON CONFLICT (key) DO UPDATE SET revision = greatest(admission.revision, EXCLUDED.revision)",
    [PROVISION_EXTRACTION_ADMISSION_REVISION],
  );
  for (const { jurisdiction, language } of Object.values(
    PROVISION_EXTRACTION_ADMISSION,
  )) {
    await client.query(
      "INSERT INTO case_law_provision_extraction_scopes AS scope (country, language, status, generation) VALUES ($1, $2, 'active', 1) ON CONFLICT (country, language) DO UPDATE SET status = 'active', generation = scope.generation + 1 WHERE scope.status <> 'active'",
      [jurisdiction, language],
    );
  }
});

type FixtureOptions = {
  verdict?: Verdict;
  onQuery?: (statement: string) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};
const fixture = ({
  verdict = { kind: "normal", signals: [] },
  onQuery = () => {},
  sleep = async () => {},
}: FixtureOptions = {}) => {
  const events: string[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  let now = Date.parse("2026-10-02T12:00:00Z");
  const withConnection: typeof withLongRunningConnection = async (
    _options,
    work,
  ) =>
    await work(
      asTestRaw<Parameters<Parameters<typeof withLongRunningConnection>[1]>[0]>(
        {
          connection: {
            unsafe: async (statement: string, parameters: unknown[] = []) => {
              onQuery(statement);
              // PGlite lacks session advisory locks. This one-session fixture
              // grants only the runtime slot; the PostgreSQL suite proves locking.
              if (statement.includes("AS acquired")) {
                return [{ acquired: true }];
              }
              return (await client.query(statement, parameters)).rows;
            },
          },
          setTransactionBudget: async () => {},
        },
      ),
    );
  const task = createCaseLawProvisionStateBackfillTask({
    withConnection,
    readVerdict: async () => verdict,
    clock: () => now++,
    observeStatus: () => {},
    sleep: async (milliseconds, signal) => {
      sleeps.push(milliseconds);
      await sleep(milliseconds, signal);
    },
  });
  return {
    events,
    sleeps,
    controller,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    run: async () =>
      await task(
        asTestRaw<SchedulerTaskContext>({
          signal: controller.signal,
          logger: {
            ...logger,
            info: (event: string) => {
              events.push(event);
            },
          },
        }),
      ),
  };
};

const checkpoint = async () => {
  const row = (
    await client.query<{
      batch: { heldSince: number | null; holdUntil: number | null };
    }>("SELECT batch FROM database_backfill_states WHERE name = $1", [
      SCHEDULER_BACKFILL_IDS.provisionState,
    ])
  ).rows.at(0);
  return row ?? panic("missing task checkpoint");
};

const cursorRows = async () =>
  (
    await client.query(
      "SELECT name, completed_at IS NOT NULL AS complete FROM case_law_provision_repair_cursors ORDER BY name",
    )
  ).rows;

describe("provision scheduler wiring through the real backfill steps", () => {
  test("a load hold starts no provision unit and records no failure", async () => {
    const task = fixture({ verdict: { kind: "stop", signals: [] } });
    await task.run();
    expect(task.events).toEqual([
      "scheduler.case_law_provision_state_backfill_held",
    ]);
    expect(task.sleeps).toEqual([]);
    expect(await cursorRows()).toEqual([]);
    expect((await checkpoint()).batch.heldSince).not.toBeNull();
    expect((await checkpoint()).batch.holdUntil).not.toBeNull();
  });

  test("a statement timeout rolls back the real page and returns its original failure cause", async () => {
    const timeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    const task = fixture({
      onQuery: (statement) => {
        if (statement.includes("ORDER BY case_law_decisions.id LIMIT")) {
          throw timeout;
        }
      },
    });
    const outcome = await task.run();
    expect(outcome).toBeDefined();
    if (outcome === undefined || outcome.isOk()) {
      return panic("Expected a scheduler task failure result");
    }
    expect(outcome.error).toBeInstanceOf(SchedulerTaskFailure);
    expect(isPgError(outcome.error, PG_ERROR.QUERY_CANCELED)).toBe(true);
    expect(task.events).toEqual([]);
    const failure = outcome.error.cause;
    expect(failure).toBeInstanceOf(ProvisionBackfillUnitError);
    if (
      !(failure instanceof ProvisionBackfillUnitError) ||
      !(failure.cause instanceof BackfillFailedError)
    ) {
      return panic("Expected typed provision timeout failure");
    }
    expect(failure.cause.cause).toBe(timeout);
    expect(isPgError(failure, PG_ERROR.QUERY_CANCELED)).toBe(true);
    expect(task.sleeps).toEqual([]);
    expect(await cursorRows()).toEqual([]);
    expect((await checkpoint()).batch).toMatchObject({
      heldSince: null,
      holdUntil: null,
    });
  });

  test("a timeout after a durable load hold still returns failure with its SQLSTATE", async () => {
    await fixture({ verdict: { kind: "stop", signals: [] } }).run();
    const held = (await checkpoint()).batch;
    expect(held.heldSince).not.toBeNull();
    expect(held.holdUntil).not.toBeNull();
    const timeout = Object.assign(new Error("statement timeout after hold"), {
      code: "57014",
    });
    const task = fixture({
      onQuery: (statement) => {
        if (statement.includes("ORDER BY case_law_decisions.id LIMIT")) {
          throw timeout;
        }
      },
    });
    task.advance(120_000);
    const outcome = await task.run();
    if (outcome === undefined || outcome.isOk()) {
      return panic("Expected failure after the hold expired");
    }
    expect(outcome.error).toBeInstanceOf(SchedulerTaskFailure);
    expect(isPgError(outcome.error, PG_ERROR.QUERY_CANCELED)).toBe(true);
    expect(task.events).not.toContain(
      "scheduler.case_law_provision_state_backfill_held",
    );
    expect(await cursorRows()).toEqual([]);
  });

  test("a timed-out CHECK scan remains pending and emits a failure", async () => {
    await fixture().run();
    await client.query(
      "ALTER TABLE case_law_provision_citations DROP CONSTRAINT provision_citations_selection_values",
    );
    await client.query(
      "ALTER TABLE case_law_provision_citations ADD CONSTRAINT provision_citations_selection_values CHECK (selection IS NULL OR selection IN ('text', 'date-window')) NOT VALID",
    );
    const timeout = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    try {
      const task = fixture({
        onQuery: (statement) => {
          if (statement.includes("VALIDATE CONSTRAINT")) {
            throw timeout;
          }
        },
      });
      const outcome = await task.run();
      if (outcome === undefined || outcome.isOk()) {
        return panic("Expected a scheduler CHECK timeout failure result");
      }
      expect(outcome.error).toBeInstanceOf(SchedulerTaskFailure);
      expect(isPgError(outcome.error, PG_ERROR.QUERY_CANCELED)).toBe(true);
      expect(task.events).toEqual([]);
      const failure = outcome.error.cause;
      expect(failure).toBeInstanceOf(ProvisionBackfillUnitError);
      if (
        !(failure instanceof ProvisionBackfillUnitError) ||
        !(failure.cause instanceof BackfillFailedError)
      ) {
        return panic("Expected typed provision CHECK timeout failure");
      }
      expect(outcome.error.cause).toBe(failure);
      expect(failure.cause.cause).toBe(timeout);
      expect(timeout.code).toBe(PG_ERROR.QUERY_CANCELED);
      expect(isPgError(failure, PG_ERROR.QUERY_CANCELED)).toBe(true);
      expect(
        (
          await client.query(
            "SELECT convalidated FROM pg_constraint WHERE conname = 'provision_citations_selection_values'",
          )
        ).rows,
      ).toEqual([{ convalidated: false }]);
      expect((await checkpoint()).batch).toMatchObject({
        heldSince: null,
        holdUntil: null,
      });
    } finally {
      await client.query(
        "ALTER TABLE case_law_provision_citations VALIDATE CONSTRAINT provision_citations_selection_values",
      );
    }
  });

  test("a completed task commits both real cursors, paces each unit and settles completion", async () => {
    const task = fixture();
    await task.run();
    expect(await cursorRows()).toEqual([
      { name: "scope-bootstrap", complete: true },
      { name: "state-seed", complete: true },
    ]);
    expect(task.sleeps).toEqual([100, 100]);
    expect((await checkpoint()).batch).toMatchObject({
      heldSince: null,
      holdUntil: null,
      stableBatches: 0,
    });
    await task.run();
    expect(task.sleeps).toEqual([100, 100]);
    expect(task.events).toEqual([
      "scheduler.case_law_provision_state_backfill",
      "scheduler.case_law_provision_state_backfill",
    ]);
  });

  test("pacing consumes the run budget and leaves the next real unit for another run", async () => {
    const task = fixture({
      sleep: async () => {
        task.advance(5 * 60_000);
      },
    });
    await task.run();
    expect(task.sleeps).toEqual([100]);
    expect(await cursorRows()).toEqual([
      { name: "scope-bootstrap", complete: true },
    ]);
    await task.run();
    expect(await cursorRows()).toEqual([
      { name: "scope-bootstrap", complete: true },
      { name: "state-seed", complete: true },
    ]);
  });

  test("abort interrupts a thirty-second pacing delay after the page commits", async () => {
    const sleeping = Promise.withResolvers<undefined>();
    const task = fixture({
      verdict: { kind: "degraded", signals: [] },
      sleep: async (milliseconds, signal) => {
        const pending = sleepWithSignal(milliseconds, undefined, { signal });
        sleeping.resolve(undefined);
        await pending;
      },
    });
    // A degraded verdict retains the seeded maximum pacing delay.
    await client.query(
      "INSERT INTO database_backfill_states (name, batch) VALUES ($1, $2::text::jsonb)",
      [
        SCHEDULER_BACKFILL_IDS.provisionState,
        JSON.stringify({
          size: 1,
          sleepMs: 30_000,
          stableBatches: 0,
          smoothedDurationMs: null,
          heldSince: null,
          holdUntil: null,
          holdCount: 0,
          holdCause: null,
        }),
      ],
    );
    const run = task.run();
    await sleeping.promise;
    expect(task.sleeps).toEqual([30_000]);
    task.controller.abort(new Error("scheduler shutdown"));
    const outcome = await Promise.race([
      run.then(() => "aborted"),
      Bun.sleep(500).then(() => "still sleeping"),
    ]);
    expect(outcome).toBe("aborted");
    expect(task.events).toEqual([
      "scheduler.case_law_provision_state_backfill_aborted",
    ]);
    expect(await cursorRows()).toEqual([
      { name: "scope-bootstrap", complete: true },
    ]);
  });
});

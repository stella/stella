import { panic } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import type { FailureGrade, FailureReason } from "@stll/errors";
import { DEFAULT_CUTOFF } from "@stll/sanctions";

import { resetFailureObservationsForTesting } from "@/api/lib/observability/failure-shadow";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import { createSanctionsMatcherPool } from "./matcher-pool";
import type { SanctionsMatcherFailure } from "./matcher-pool";
import { createMatcherTestClock } from "./test-fixtures/matcher-test-clock";

let logs: RecordingLogger;
let analytics: RecordingAnalytics;
beforeEach(() => {
  logs = installRecordingLogger();
  analytics = installRecordingAnalytics();
  resetFailureObservationsForTesting();
});
afterEach(() => {
  logs.restore();
  analytics.restore();
  resetFailureObservationsForTesting();
});

type FixtureOptions = Pick<
  NonNullable<Parameters<typeof createSanctionsMatcherPool>[0]>,
  "createWorker"
>;
const fixture = (options: FixtureOptions = {}) => {
  const workers: Worker[] = [];
  const clock = createMatcherTestClock();
  const pool = createSanctionsMatcherPool({
    deadlineMs: 10,
    clock,
    createWorker: () => {
      const worker = new Worker(
        new URL("sanctions-matcher-worker.ts", import.meta.url),
      );
      workers.push(worker);
      return worker;
    },
    ...options,
  });
  return {
    pool,
    clock,
    worker: () =>
      workers.at(-1) ?? panic("Expected an admitted matcher worker"),
  };
};

const failureCases = {
  "deadline-exceeded": {
    grade: "transient",
    reason: "sanctions_matcher_deadline",
    exercise: async () => {
      const { pool, clock } = fixture();
      const entered = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();
      const pending = pool.run(async () => {
        entered.resolve(undefined);
        await held.promise;
        throw new TypeError("Synthetic late operation failure");
      });
      try {
        await entered.promise;
        clock.advance(10);
        expect(await pending).toBeNull();
        // The losing operation's rejection is fallout of the reported deadline.
        held.resolve(undefined);
      } finally {
        held.resolve(undefined);
        await pool.close();
      }
    },
  },
  "admission-refused": {
    grade: "transient",
    reason: "sanctions_matcher_saturated",
    exercise: async () => {
      const { pool } = fixture();
      const entered = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();
      const active = pool.run(async () => {
        entered.resolve(undefined);
        await held.promise;
        return "active";
      });
      await entered.promise;
      const queued = [
        pool.run(async () => "queued-one"),
        pool.run(async () => "queued-two"),
      ];
      try {
        expect(await pool.run(async () => "not-admitted")).toBeNull();
        held.resolve(undefined);
        expect(await active).toBe("active");
        expect(await Promise.all(queued)).toEqual(["queued-one", "queued-two"]);
      } finally {
        held.resolve(undefined);
        await pool.close();
      }
    },
  },
  "pool-closed": {
    grade: "anticipated",
    reason: "sanctions_matcher_closed",
    exercise: async () => {
      const { pool } = fixture();
      await pool.close();
      expect(await pool.run(async () => "not-admitted")).toBeNull();
    },
  },
  "worker-failed": {
    grade: "defect",
    reason: "sanctions_matcher_failed",
    exercise: async () => {
      const { pool } = fixture({
        createWorker: () => {
          throw new TypeError("Synthetic worker creation failure");
        },
      });
      try {
        expect(await pool.run(async () => "not-started")).toBeNull();
      } finally {
        await pool.close();
      }
    },
  },
  "operation-failed": {
    grade: "defect",
    reason: "sanctions_matcher_failed",
    exercise: async () => {
      const { pool } = fixture();
      try {
        expect(
          await pool.run(async () => {
            throw new TypeError("Synthetic operation failure");
          }),
        ).toBeNull();
      } finally {
        await pool.close();
      }
    },
  },
} as const satisfies Record<
  SanctionsMatcherFailure["code"],
  { grade: FailureGrade; reason: FailureReason; exercise: () => Promise<void> }
>;

describe("matcher failure reporting", () => {
  test.each(Object.entries(failureCases))(
    "reports %s exactly once with its grade",
    async (code, { exercise, grade, reason }) => {
      await exercise();
      const failures = logs.records.filter(
        ({ message }) => message === "sanctions.matcher_failed",
      );
      expect(failures).toHaveLength(1);
      expect(failures.at(0)?.severityText).toBe(
        grade === "defect" ? "ERROR" : "WARN",
      );
      expect(failures.at(0)?.attributes).toMatchObject({
        "error.type": "SanctionsMatcherFailure",
        "error.code": code,
        "failure.grade": grade,
        "failure.reason": reason,
        stage: code,
        feature: "sanctions.matcher",
      });
      expect(analytics.exceptions()).toHaveLength(grade === "defect" ? 1 : 0);
    },
  );

  test.each(["error", "exit"] as const)(
    "reports an active worker %s once and preserves recovery",
    async (event) => {
      const { pool, worker } = fixture();
      const entered = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();
      const pending = pool.run(async () => {
        entered.resolve(undefined);
        await held.promise;
        return "late";
      });
      try {
        await entered.promise;
        worker().emit(event, new TypeError("Synthetic worker fault"));
        expect(await pending).toBeNull();
        held.resolve(undefined);
        expect(await pool.run(async () => "recovered")).toBe("recovered");
        expect(
          logs.records.filter(
            ({ message }) => message === "sanctions.matcher_failed",
          ),
        ).toHaveLength(1);
        expect(analytics.exceptions()).toHaveLength(1);
      } finally {
        held.resolve(undefined);
        await pool.close();
      }
    },
  );

  test("reports an idle worker error without waiting for a request to fail", async () => {
    const { pool, worker } = fixture();
    try {
      expect(await pool.run(async () => "completed")).toBe("completed");
      worker().emit("error", new TypeError("Synthetic idle worker failure"));
      expect(
        logs.records.filter(
          ({ message }) => message === "sanctions.matcher_failed",
        ),
      ).toHaveLength(1);
      expect(analytics.exceptions()).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  test("a failed worker transfer is reported before returning unavailable", async () => {
    const { pool, worker } = fixture();
    try {
      expect(
        await pool.run(async (session) => {
          worker().postMessage = () => {
            throw new TypeError("Synthetic transfer failure");
          };
          return await session.match({
            source: "eu",
            editionId: "synthetic-edition",
            list: null,
            query: { name: "Synthetic Subject", entityType: "organisation" },
            cutoff: DEFAULT_CUTOFF,
            limit: 1,
          });
        }),
      ).toBeNull();
      const failures = logs.records.filter(
        ({ message }) => message === "sanctions.matcher_failed",
      );
      expect(failures).toHaveLength(1);
      expect(failures.at(0)?.attributes).toMatchObject({
        "error.code": "worker-failed",
        "failure.grade": "defect",
      });
      expect(analytics.exceptions()).toHaveLength(1);
      expect(worker().listenerCount("message")).toBe(0);
    } finally {
      await pool.close();
    }
  });

  test("closing an active lease reports shutdown without a defect", async () => {
    const { pool } = fixture();
    const entered = Promise.withResolvers<undefined>();
    const held = Promise.withResolvers<undefined>();
    const pending = pool.run(async () => {
      entered.resolve(undefined);
      await held.promise;
      return "late";
    });
    await entered.promise;
    await pool.close();
    expect(await pending).toBeNull();
    held.resolve(undefined);
    const failures = logs.records.filter(
      ({ message }) => message === "sanctions.matcher_failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures.at(0)?.attributes).toMatchObject({
      "error.code": "pool-closed",
      "failure.grade": "anticipated",
    });
    expect(analytics.exceptions()).toEqual([]);
  });

  test.each(["completed", null])(
    "a completed lease returning %s emits no failure",
    async (value) => {
      const { pool } = fixture();
      try {
        expect(await pool.run(async () => value)).toBe(value);
        expect(logs.records).toEqual([]);
        expect(analytics.exceptions()).toEqual([]);
      } finally {
        await pool.close();
      }
    },
  );
});

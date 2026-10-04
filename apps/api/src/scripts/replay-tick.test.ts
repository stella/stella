import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  combine,
  initialBatchState,
  type Verdict,
} from "@stll/db-load-gate/health";
import { ebsBalance } from "@stll/db-load-gate/indicators";

import { readReplayTickEnvironment } from "@/api/env-replay";
import type { BackgroundReplayTickReport } from "@/api/handlers/case-law/ingestion/background-replay";
import {
  REPLAY_ENROLMENT,
  REPLAY_HEALTH_CONFIG,
} from "@/api/handlers/case-law/ingestion/replay-enrolment";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  assertReplaySlot,
  createReplayPreflightGate,
  readReplayGate,
  replayTickMetricRecord,
  runReplayTickScript,
} from "@/api/scripts/replay-tick";

const enabledEnvironment = {
  CASE_LAW_REPLAY_ENABLED: true,
  CASE_LAW_REPLAY_KILL_SWITCH: false,
  CASE_LAW_REPLAY_DISABLED_SOURCES: "",
};

const report = (
  status: BackgroundReplayTickReport["status"],
): BackgroundReplayTickReport => ({
  status,
  source: null,
  attempted: 0,
  applied: 0,
  blocked: 0,
  errors: 0,
  failed: 0,
  retryExhausted: 0,
  retryTerminal: 0,
  heldTooLong: false,
});

describe("scheduled replay entrypoint", () => {
  test("a disabled subprocess needs no database or S3 environment and loads no pools", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        new URL("replay-tick.ts", import.meta.url).pathname,
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"], NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(
      '{"event":"case_law.replay.tick","status":"disabled"}',
    );
  });

  test("production cannot acquire fixture overrides before database or storage setup", async () => {
    const entry = new URL("replay-tick.ts", import.meta.url).pathname;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--eval",
        `const { getReplayTickFixtureRunner } = await import(${JSON.stringify(entry)}); getReplayTickFixtureRunner();`,
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      env: { PATH: process.env["PATH"], NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("Replay tick fixtures require a local test run");
    expect(stderr).not.toContain("DATABASE_URL");
    expect(stderr).not.toContain("S3_BUCKET");
  });

  test("committed enrolment remains disabled for every source", () => {
    expect(
      new Set(Object.values(REPLAY_ENROLMENT).map(({ mode }) => mode)),
    ).toEqual(new Set(["off"]));
  });

  test("default-off environment, global kill and unenrolled sources perform no setup", async () => {
    let setups = 0;
    const runEnabled = async () => {
      setups++;
      return report("complete");
    };
    for (const environment of [
      { ...enabledEnvironment, CASE_LAW_REPLAY_ENABLED: false },
      { ...enabledEnvironment, CASE_LAW_REPLAY_KILL_SWITCH: true },
    ]) {
      const records: unknown[] = [];
      expect(
        await runReplayTickScript({
          args: [],
          environment,
          policies: [{ mode: "dry-run", dailyBudget: 1 }],
          runEnabled,
          log: (record) => {
            records.push(record);
          },
        }),
      ).toBe(0);
      expect(records).toEqual([
        { event: "case_law.replay.tick", status: "disabled" },
      ]);
    }
    expect(
      await runReplayTickScript({
        args: [],
        environment: enabledEnvironment,
        runEnabled,
        log: () => undefined,
      }),
    ).toBe(0);
    expect(setups).toBe(0);
  });

  test("environment reader defaults to disabled with no flags", () => {
    const oldEnabled = process.env["CASE_LAW_REPLAY_ENABLED"];
    const oldKill = process.env["CASE_LAW_REPLAY_KILL_SWITCH"];
    delete process.env["CASE_LAW_REPLAY_ENABLED"];
    delete process.env["CASE_LAW_REPLAY_KILL_SWITCH"];
    try {
      const environment = readReplayTickEnvironment();
      expect(environment.CASE_LAW_REPLAY_ENABLED).toBe(false);
      expect(environment.CASE_LAW_REPLAY_KILL_SWITCH).toBe(false);
    } finally {
      if (oldEnabled !== undefined) {
        process.env["CASE_LAW_REPLAY_ENABLED"] = oldEnabled;
      }
      if (oldKill !== undefined) {
        process.env["CASE_LAW_REPLAY_KILL_SWITCH"] = oldKill;
      }
    }
  });

  test("failure reports and rejected setup exit nonzero; normal stops exit zero", async () => {
    for (const status of [
      "retryable",
      "failed",
      "complete",
      "held",
      "time-limit",
    ] as const) {
      expect(
        await runReplayTickScript({
          args: [],
          environment: enabledEnvironment,
          policies: [{ mode: "dry-run", dailyBudget: 1 }],
          runEnabled: async () => report(status),
          log: () => undefined,
        }),
      ).toBe(status === "failed" ? 1 : 0);
    }
    const records: unknown[] = [];
    expect(
      await runReplayTickScript({
        args: [],
        environment: enabledEnvironment,
        policies: [{ mode: "dry-run", dailyBudget: 1 }],
        runEnabled: async () => {
          throw new TypeError("fixture setup failure");
        },
        log: (record) => {
          records.push(record);
        },
      }),
    ).toBe(1);
    expect(records).toMatchObject([
      {
        event: "case_law.replay.tick",
        status: "failed",
        code: "unexpected",
        messageClass: "unexpected",
        "case_law.replay.tick.failed": 1,
        _aws: {
          CloudWatchMetrics: [
            {
              Dimensions: [[]],
              Metrics: [{ Name: "case_law.replay.tick.failed", Unit: "Count" }],
            },
          ],
        },
      },
    ]);
  });

  test("deadline signal exists before setup and prevents starting work after expiration", async () => {
    const controller = new AbortController();
    const steps: string[] = [];
    const exit = await runReplayTickScript({
      args: [],
      environment: enabledEnvironment,
      policies: [{ mode: "dry-run", dailyBudget: 1 }],
      timeoutSignal: (duration) => {
        expect(duration).toBeGreaterThan(0);
        steps.push("deadline");
        return controller.signal;
      },
      runEnabled: async (signal) => {
        steps.push("setup");
        expect(signal).toBe(controller.signal);
        controller.abort(new DOMException("tick expired", "TimeoutError"));
        signal.throwIfAborted();
        return report("complete");
      },
      log: () => undefined,
    });
    expect(exit).toBe(1);
    expect(steps).toEqual(["deadline", "setup"]);
    let started = false;
    expect(
      await runReplayTickScript({
        args: [],
        environment: enabledEnvironment,
        policies: [{ mode: "dry-run", dailyBudget: 1 }],
        timeoutSignal: () => controller.signal,
        runEnabled: async () => {
          started = true;
          return report("complete");
        },
        log: () => undefined,
      }),
    ).toBe(1);
    expect(started).toBe(false);
  });

  test("unexpected arguments are rejected before setup", async () => {
    let started = false;
    expect(
      await runReplayTickScript({
        args: ["--apply"],
        environment: enabledEnvironment,
        policies: [{ mode: "dry-run", dailyBudget: 1 }],
        runEnabled: async () => {
          started = true;
          return report("complete");
        },
        log: () => undefined,
      }),
    ).toBe(1);
    expect(started).toBe(false);
  });

  test("explicit dry-run reset invokes only the reset seam and logs its source", async () => {
    const controller = new AbortController();
    const resets: string[] = [];
    const records: unknown[] = [];
    let ticks = 0;
    const adapterKey = ADAPTER_KEYS.EU_ECJ;
    expect(
      await runReplayTickScript({
        args: ["--reset-dry-run", adapterKey],
        environment: enabledEnvironment,
        enrolment: {
          ...REPLAY_ENROLMENT,
          [adapterKey]: { mode: "dry-run", dailyBudget: 1 },
        },
        timeoutSignal: () => controller.signal,
        resetDryRun: async (options) => {
          expect(options.signal).toBe(controller.signal);
          expect(options.policy).toEqual({ mode: "dry-run", dailyBudget: 1 });
          resets.push(options.adapterKey);
          return true;
        },
        runEnabled: async () => {
          ticks++;
          return report("complete");
        },
        log: (record) => {
          records.push(record);
        },
      }),
    ).toBe(0);
    expect(resets).toEqual([adapterKey]);
    expect(ticks).toBe(0);
    expect(records).toEqual([
      {
        event: "case_law.replay.dry_run_reset",
        adapterKey,
        status: "complete",
      },
    ]);
  });

  test("reset rejects invalid arguments and off or enrolled registry modes before setup", async () => {
    let effects = 0;
    const resetDryRun = async () => {
      effects++;
      return true;
    };
    for (const args of [
      ["--reset-dry-run"],
      ["--reset-dry-run", "unknown-adapter"],
      ["--reset-dry-run", ADAPTER_KEYS.EU_ECJ, "extra"],
    ]) {
      expect(
        await runReplayTickScript({
          args,
          environment: enabledEnvironment,
          resetDryRun,
          log: () => undefined,
        }),
      ).toBe(1);
    }
    for (const policy of [
      { mode: "off" },
      { mode: "enrolled", dailyBudget: 1, reviewedDryRun: "fixture review" },
    ] as const) {
      expect(
        await runReplayTickScript({
          args: ["--reset-dry-run", ADAPTER_KEYS.EU_ECJ],
          environment: enabledEnvironment,
          enrolment: { ...REPLAY_ENROLMENT, [ADAPTER_KEYS.EU_ECJ]: policy },
          resetDryRun,
          log: () => undefined,
        }),
      ).toBe(1);
    }
    expect(effects).toBe(0);
  });

  test("reset obeys global enable, global kill and source kill without setup", async () => {
    let effects = 0;
    const resetDryRun = async () => {
      effects++;
      return true;
    };
    for (const environment of [
      { ...enabledEnvironment, CASE_LAW_REPLAY_ENABLED: false },
      { ...enabledEnvironment, CASE_LAW_REPLAY_KILL_SWITCH: true },
      {
        ...enabledEnvironment,
        CASE_LAW_REPLAY_DISABLED_SOURCES: ` ${ADAPTER_KEYS.EU_ECJ} `,
      },
    ]) {
      expect(
        await runReplayTickScript({
          args: ["--reset-dry-run", ADAPTER_KEYS.EU_ECJ],
          environment,
          enrolment: {
            ...REPLAY_ENROLMENT,
            [ADAPTER_KEYS.EU_ECJ]: { mode: "dry-run", dailyBudget: 1 },
          },
          resetDryRun,
          log: () => undefined,
        }),
      ).toBe(0);
    }
    expect(effects).toBe(0);
  });

  test("reset preserves the shared deadline and reports a held maintenance lane", async () => {
    const adapterKey = ADAPTER_KEYS.EU_ECJ;
    const records: unknown[] = [];
    expect(
      await runReplayTickScript({
        args: ["--reset-dry-run", adapterKey],
        environment: enabledEnvironment,
        enrolment: {
          ...REPLAY_ENROLMENT,
          [adapterKey]: { mode: "dry-run", dailyBudget: 1 },
        },
        resetDryRun: async () => false,
        log: (record) => {
          records.push(record);
        },
      }),
    ).toBe(0);
    expect(records).toEqual([
      {
        event: "case_law.replay.dry_run_reset",
        adapterKey,
        status: "maintenance-held",
      },
    ]);
    const controller = new AbortController();
    controller.abort();
    let effects = 0;
    expect(
      await runReplayTickScript({
        args: ["--reset-dry-run", adapterKey],
        environment: enabledEnvironment,
        enrolment: {
          ...REPLAY_ENROLMENT,
          [adapterKey]: { mode: "dry-run", dailyBudget: 1 },
        },
        timeoutSignal: () => controller.signal,
        resetDryRun: async () => {
          effects++;
          return true;
        },
        log: () => undefined,
      }),
    ).toBe(1);
    expect(effects).toBe(0);
  });
});

describe("replay runtime boundaries", () => {
  test("a failed load-gate read is unknown, never normal", async () => {
    let settled = 0;
    const gate = await readReplayGate({
      readVerdict: async () => {
        throw new TypeError("fixture gate read failure");
      },
      settle: async () => {
        settled++;
      },
    });
    expect(gate).toEqual({ kind: "unknown", signals: [] });
    expect(settled).toBe(1);
    const normal: Verdict = { kind: "normal", signals: [] };
    expect(
      await readReplayGate({
        readVerdict: async () => normal,
        settle: async () => undefined,
      }),
    ).toBe(normal);
  });

  test("the slot assertion rejects session replacement and aborted ticks", async () => {
    const controller = new AbortController();
    await assertReplaySlot({
      expectedBackend: 123,
      queryBackend: async () => 123,
      signal: controller.signal,
    });
    const rejected1 = await Result.tryPromise({
      try: async () =>
        await assertReplaySlot({
          expectedBackend: 123,
          queryBackend: async () => 456,
          signal: controller.signal,
        }),
      catch: (cause) => cause,
    });
    expect(rejected1.isErr()).toBe(true);
    if (rejected1.isErr()) {
      expect(rejected1.error).toBeInstanceOf(Error);
      if (rejected1.error instanceof Error) {
        expect(rejected1.error.message).toContain(
          "Heavy-work session was replaced",
        );
      }
    }
    const rejected2 = await Result.tryPromise({
      try: async () =>
        await assertReplaySlot({
          expectedBackend: 123,
          queryBackend: async () => undefined,
          signal: controller.signal,
        }),
      catch: (cause) => cause,
    });
    expect(rejected2.isErr()).toBe(true);
    if (rejected2.isErr()) {
      expect(rejected2.error).toBeInstanceOf(Error);
      if (rejected2.error instanceof Error) {
        expect(rejected2.error.message).toContain(
          "Heavy-work session was replaced",
        );
      }
    }
    controller.abort(new DOMException("tick expired", "TimeoutError"));
    let queried = false;
    const rejected3 = await Result.tryPromise({
      try: async () =>
        await assertReplaySlot({
          expectedBackend: 123,
          queryBackend: async () => {
            queried = true;
            return 123;
          },
          signal: controller.signal,
        }),
      catch: (cause) => cause,
    });
    expect(rejected3.isErr()).toBe(true);
    if (rejected3.isErr()) {
      expect(rejected3.error).toBeInstanceOf(Error);
      if (rejected3.error instanceof Error) {
        expect(rejected3.error.message).toContain("tick expired");
      }
    }
    expect(queried).toBe(false);
  });

  test("EMF declares every numeric value and only bounded source dimensions", () => {
    const source = {
      id: createSafeId<"caseLawSource">(),
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      currentParserVersion: 1,
      dailyBudget: 1,
      mode: "dry-run",
      rowsBehind: 2,
    } as const;
    const values = {
      "case_law.replay.tick.failed": 1,
      "case_law.replay.lag.oldest_age_ms": 20,
    };
    const record = replayTickMetricRecord({
      source,
      event: "case_law.replay.tick",
      values,
      timestamp: 123,
    });
    expect(record._aws.Timestamp).toBe(123);
    expect(record._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: "Stella/CaseLaw",
        Dimensions: [["AdapterKey", "SourceId", "Mode"]],
        Metrics: [
          { Name: "case_law.replay.tick.failed", Unit: "Count" },
          { Name: "case_law.replay.lag.oldest_age_ms", Unit: "Milliseconds" },
        ],
      },
    ]);
    expect(record).toMatchObject({
      AdapterKey: source.adapterKey,
      SourceId: source.id,
      Mode: source.mode,
      ...values,
    });
  });
});

describe("replay load hysteresis", () => {
  test("preflight preserves a load hold until the configured resume floor", async () => {
    let clock = Date.parse("2026-10-02T10:00:00Z");
    let balance = REPLAY_HEALTH_CONFIG.hardFloor - 1;
    let saved = initialBatchState(REPLAY_HEALTH_CONFIG);
    const gate = createReplayPreflightGate({
      clock: () => clock,
      loadState: async () => saved,
      saveState: async (state) => {
        saved = state;
      },
      readVerdict: async () => {
        const signal = await ebsBalance({
          config: REPLAY_HEALTH_CONFIG,
          now: () => clock,
          read: async () => ({
            byteBalancePct: balance,
            ioBalancePct: balance,
            observedAt: new Date(clock).toISOString(),
          }),
        });
        return combine([signal]);
      },
    });
    expect((await gate.readVerdict()).kind).toBe("unknown");
    expect(saved.holdCause).toBe("load");
    clock = (saved.holdUntil ?? clock) + 1;
    balance = REPLAY_HEALTH_CONFIG.resumeFloor - 1;
    expect((await gate.readVerdict()).kind).toBe("unknown");
    expect(saved.holdCause).toBe("load");
    clock = (saved.holdUntil ?? clock) + 1;
    balance = REPLAY_HEALTH_CONFIG.resumeFloor;
    expect((await gate.readVerdict()).kind).toBe("normal");
    expect(saved.holdCause).toBeNull();
  });
});

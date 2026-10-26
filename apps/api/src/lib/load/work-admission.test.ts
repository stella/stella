import { Result } from "better-result";
import { afterEach, expect, expectTypeOf, spyOn, test } from "bun:test";

import {
  type LogRecord,
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";

import {
  type AdmittedWork,
  admitWork,
  assertWorkAdmission,
  createWorkAdmission,
  resetWorkAdmissionForTesting,
  type WorkAdmission,
  WorkDeadlineError,
  WorkRefusal,
} from "./work-admission";

afterEach(resetLogSinkForTesting);

test("the process pool resets only after admitted work settles", async () => {
  resetWorkAdmissionForTesting();
  const rss = spyOn(process.memoryUsage, "rss").mockReturnValue(0);
  const blocked = Promise.withResolvers<undefined>();
  const reached = Promise.withResolvers<undefined>();
  const running = admitWork({
    pool: "heavy-sidecar",
    kind: "test-reset",
    run: async () => {
      reached.resolve(undefined);
      await blocked.promise;
    },
  });
  try {
    await reached.promise;
    expect(rss).toHaveBeenCalled();
    expect(resetWorkAdmissionForTesting).toThrow(
      "Cannot reset work admission while work is active",
    );
    blocked.resolve(undefined);
    expect((await running).isOk()).toBe(true);
    expect(resetWorkAdmissionForTesting).not.toThrow();
  } finally {
    blocked.resolve(undefined);
    try {
      await running;
      resetWorkAdmissionForTesting();
    } finally {
      rss.mockRestore();
    }
  }
});

test("memory pressure refuses new work", async () => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  const admission = createWorkAdmission({
    readRssBytes: () => Number.MAX_SAFE_INTEGER,
  });
  const result = await admission.admit({
    pool: "heavy-sidecar",
    kind: "test",
    run: async () => 1,
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(WorkRefusal);
    if (!WorkRefusal.is(result.error)) {
      throw new Error("expected work refusal");
    }
    expect(result.error.reason).toBe("memory");
  }
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    message: "work.refused",
    attributes: {
      pool: "heavy-sidecar",
      kind: "test",
      reason: "memory",
      retryAfterMs: expect.any(Number),
      waitedMs: expect.any(Number),
      bytes: 0,
    },
  });
});

test("admission emits no refusal event", async () => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  const admission = createWorkAdmission({ readRssBytes: () => 0 });
  await admission.admit({
    pool: "heavy-sidecar",
    kind: "test",
    bytes: 42,
    run: async () => undefined,
  });
  expect(records.filter(({ message }) => message === "work.refused")).toEqual(
    [],
  );
});

type AcceptedAsWork<Run, T> = Run extends AdmittedWork<T> ? true : false;

test("generator work is rejected by the admission contract", () => {
  expectTypeOf<
    AcceptedAsWork<() => Promise<number>, number>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AcceptedAsWork<
      () => Promise<AsyncGenerator<never, number>>,
      AsyncGenerator<never, number>
    >
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AcceptedAsWork<
      () => Promise<Generator<never, number>>,
      Generator<never, number>
    >
  >().toEqualTypeOf<false>();
});

test("deadline aborts with a typed reason but holds the slot until run settles", async () => {
  const admission = createWorkAdmission({ readRssBytes: () => 0 });
  const aborted = Promise.withResolvers<undefined>();
  let proof: WorkAdmission | undefined;
  let settle: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const running = admission.admit({
    pool: "heavy-sidecar",
    kind: "test",
    deadlineMs: 5,
    run: async (value) => {
      proof = value;
      await new Promise<void>((resolve) => {
        value.signal.addEventListener(
          "abort",
          () => {
            expect(value.signal.reason).toBeInstanceOf(WorkDeadlineError);
            aborted.resolve(undefined);
            resolve();
          },
          { once: true },
        );
      });
      await blocked;
    },
  });
  await aborted.promise;
  const refused = await admission.admit({
    pool: "heavy-sidecar",
    kind: "next",
    run: async () => undefined,
  });
  expect(Result.isError(refused)).toBe(true);
  settle();
  await running;
  const settledProof = proof;
  if (settledProof === undefined) {
    throw new Error("expected proof");
  }
  expect(() => assertWorkAdmission(settledProof)).toThrow("outlived");
});

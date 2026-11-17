import { describe, expect, test } from "bun:test";

import { withFakeTimers } from "@stll/test-kit";

import { nextMacrotask } from "./event-loop";
import { TimeoutError, withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  test("returns the operation result when it settles before the deadline", async () => {
    await withFakeTimers(async (timers) => {
      const operation = Promise.withResolvers<string>();
      const started = Promise.withResolvers<AbortSignal>();
      let settled = false;
      const pending = withTimeout(
        async (signal) => {
          started.resolve(signal);
          return await operation.promise;
        },
        { label: "fast", timeoutMs: 1000 },
      ).then((value) => {
        settled = true;
        return value;
      });
      try {
        const signal = await started.promise;
        await timers.advance(999);
        expect(settled).toBe(false);
        expect(signal.aborted).toBe(false);
        expect(timers.pendingTimers()).toBe(1);
        operation.resolve("ok");
        expect(await pending).toBe("ok");
        expect(signal.aborted).toBe(false);
        expect(timers.pendingTimers()).toBe(0);
      } finally {
        operation.resolve("cleanup");
        await Promise.allSettled([pending]);
      }
    });
  });

  test("rejects with a TimeoutError when the operation outlives the deadline", async () => {
    await withFakeTimers(async (timers) => {
      const operation = Promise.withResolvers<string>();
      const started = Promise.withResolvers<AbortSignal>();
      const pending = withTimeout(
        async (signal) => {
          started.resolve(signal);
          return await operation.promise;
        },
        { label: "wedged-read", timeoutMs: 10 },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        const signal = await started.promise;
        await timers.advance(9);
        expect(signal.aborted).toBe(false);
        await timers.advance(1);
        expect(signal.aborted).toBe(true);
        const captured = await pending;
        expect(captured).toBeInstanceOf(TimeoutError);
        expect(captured).toMatchObject({ label: "wedged-read", timeoutMs: 10 });
        expect(signal.reason).toBe(captured);
        expect(timers.pendingTimers()).toBe(0);
      } finally {
        operation.resolve("cleanup");
        await pending;
      }
    });
  });

  test("an injected timer decides when the deadline fires", async () => {
    let fire: (() => void) | undefined;
    let scheduledMs: number | undefined;
    const pending = withTimeout(
      async () =>
        await new Promise<never>(() => {
          // Intentionally pending: only the injected deadline may settle it.
        }),
      {
        label: "injected-deadline",
        timeoutMs: 50,
        scheduleTimeout: (callback, delayMs) => {
          fire = callback;
          scheduledMs = delayMs;
          return () => undefined;
        },
      },
    );

    expect(scheduledMs).toBe(50);
    fire?.();
    const rejection: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(rejection).toMatchObject({
      label: "injected-deadline",
      timeoutMs: 50,
    });
  });

  test("cancels an injected timer once the operation settles", async () => {
    let cancelled = false;
    const result = await withTimeout(async () => "ok", {
      label: "injected-cancel",
      timeoutMs: 50,
      scheduleTimeout: () => () => {
        cancelled = true;
      },
    });

    expect(result).toBe("ok");
    expect(cancelled).toBe(true);
  });

  test("timeoutMs 0 disables the deadline", async () => {
    await withFakeTimers(async (timers) => {
      const operation = Promise.withResolvers<string>();
      const started = Promise.withResolvers<AbortSignal>();
      let settled = false;
      const pending = withTimeout(
        async (signal) => {
          started.resolve(signal);
          return await operation.promise;
        },
        { label: "disabled", timeoutMs: 0 },
      ).then((value) => {
        settled = true;
        return value;
      });
      try {
        const signal = await started.promise;
        expect(timers.pendingTimers()).toBe(0);
        await timers.advance(10_000);
        expect(settled).toBe(false);
        expect(signal.aborted).toBe(false);
        operation.resolve("ok");
        expect(await pending).toBe("ok");
        expect(timers.pendingTimers()).toBe(0);
      } finally {
        operation.resolve("cleanup");
        await Promise.allSettled([pending]);
      }
    });
  });

  test("a late operation rejection after the timeout does not surface as unhandled", async () => {
    let rejectedLate = false;
    const onUnhandled = () => {
      rejectedLate = true;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await withFakeTimers(async (timers) => {
        const operation = Promise.withResolvers<string>();
        const started = Promise.withResolvers<AbortSignal>();
        const pending = withTimeout(
          async (signal) => {
            started.resolve(signal);
            return await operation.promise;
          },
          { label: "late-wrapper", timeoutMs: 5 },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          const signal = await started.promise;
          await timers.advance(5);
          expect(signal.aborted).toBe(true);
          const captured = await pending;
          expect(captured).toBeInstanceOf(TimeoutError);
          expect(captured).toMatchObject({ label: "late-wrapper" });
          expect(signal.reason).toBe(captured);
          operation.reject(
            new TimeoutError({
              message: "late connection failure",
              label: "late-op",
            }),
          );
          expect(timers.pendingTimers()).toBe(0);
        } finally {
          operation.resolve("cleanup");
          await pending;
        }
      });
      // Rejection reporting belongs to a genuine host turn, not fake time.
      await nextMacrotask();
      expect(rejectedLate).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stops waiting when its abort signal fires", async () => {
    const controller = new AbortController();
    let operationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const pending = withTimeout(
      async () => {
        operationStarted?.();
        return await new Promise<never>(() => {
          // Intentionally pending: only the abort signal may settle the wrapper.
        });
      },
      {
        label: "aborted-operation",
        signal: controller.signal,
        timeoutMs: 60_000,
      },
    );

    await started;
    controller.abort();

    const rejection: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: "The operation was aborted.",
      name: "AbortError",
    });
  });

  test("passes deadline cancellation to the underlying operation", async () => {
    let operationSignal: AbortSignal | undefined;

    const rejection: unknown = await withTimeout(
      async (signal) => {
        operationSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("Aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      },
      { label: "abortable-timeout", timeoutMs: 5 },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(TimeoutError);
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBe(rejection);
  });

  test("passes caller cancellation to the underlying operation", async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const pending = withTimeout(
      async (signal) => {
        operationSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("Aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      },
      {
        label: "abortable-operation",
        signal: controller.signal,
        timeoutMs: 60_000,
      },
    );

    await Promise.resolve();
    controller.abort();
    const rejection: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(operationSignal?.aborted).toBe(true);
  });

  test("does not start an operation for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;

    const rejection: unknown = await withTimeout(
      async () => {
        started = true;
      },
      {
        label: "pre-aborted-operation",
        signal: controller.signal,
        timeoutMs: 60_000,
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(started).toBe(false);
    expect(rejection).toMatchObject({ name: "AbortError" });
  });
});

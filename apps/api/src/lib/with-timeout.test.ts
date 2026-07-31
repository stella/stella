import { describe, expect, test } from "bun:test";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { withTimeout } from "@/api/lib/with-timeout";

describe("withTimeout", () => {
  test("returns the operation result when it settles before the deadline", async () => {
    const result = await withTimeout(
      async () => {
        await Bun.sleep(5);
        return "ok";
      },
      { label: "fast", timeoutMs: 1000 },
    );

    expect(result).toBe("ok");
  });

  test("rejects with a TimeoutError when the operation outlives the deadline", async () => {
    let captured: unknown;
    try {
      await withTimeout(
        async () => {
          await Bun.sleep(1000);
          return "never";
        },
        { label: "wedged-read", timeoutMs: 10 },
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    expect(captured).toMatchObject({ label: "wedged-read", timeoutMs: 10 });
  });

  test("timeoutMs 0 disables the deadline", async () => {
    const result = await withTimeout(
      async () => {
        await Bun.sleep(10);
        return "ok";
      },
      { label: "disabled", timeoutMs: 0 },
    );

    expect(result).toBe("ok");
  });

  test("a late operation rejection after the timeout does not surface as unhandled", async () => {
    let rejectedLate = false;
    const onUnhandled = () => {
      rejectedLate = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      let captured: unknown;
      try {
        await withTimeout(
          async () => {
            // Settles (rejecting) well after the deadline has already won.
            await Bun.sleep(20);
            throw new TimeoutError({
              message: "late connection failure",
              label: "late-op",
            });
          },
          { label: "late-wrapper", timeoutMs: 5 },
        );
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(TimeoutError);
      expect(captured).toMatchObject({ label: "late-wrapper" });

      await Bun.sleep(40);
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

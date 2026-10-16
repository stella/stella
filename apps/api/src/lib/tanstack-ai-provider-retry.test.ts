import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ModelDeadlineExceededError,
  ProviderCallError,
} from "@/api/lib/errors/provider-call-error";
import { PROVIDER_RETRY_WAIT_CAP_MS } from "@/api/lib/errors/provider-retry-delay";
import {
  AIGenerationCancelledError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import {
  withGenerationDeadline,
  withProviderRetryWait,
} from "@/api/lib/tanstack-ai-generate";

const rateLimited = (retryAfterMs: number | undefined) =>
  new ProviderCallError({
    model: { provider: "google", keySource: "byok" },
    status: 429,
    kind: "quota_exhausted",
    facts: { status: 429 },
    retryAfterMs,
  });

// A call that fails with each queued failure in turn, then answers.
const scripted = (failures: unknown[]) => {
  const calls: number[] = [];
  const run = async () => {
    calls.push(performance.now());
    const failure = failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return "answer";
  };
  return { calls, run };
};

describe("withProviderRetryWait", () => {
  test("waits out a short stated delay and tries once more", async () => {
    const call = scripted([rateLimited(40)]);
    expect(await withProviderRetryWait(undefined, call.run)).toBe("answer");
    expect(call.calls).toHaveLength(2);
    const [first = 0, second = 0] = call.calls;
    expect(second - first).toBeGreaterThanOrEqual(35);
  });

  test("a second refusal reaches the caller with its delay", async () => {
    const second = rateLimited(5);
    const call = scripted([rateLimited(5), second]);
    const outcome = await Result.tryPromise({
      try: async () => await withProviderRetryWait(undefined, call.run),
      catch: (error: unknown) => error,
    });
    expect(call.calls).toHaveLength(2);
    expect(Result.isError(outcome) && outcome.error).toBe(second);
  });

  for (const [name, failure] of [
    ["a delay past the cap", rateLimited(PROVIDER_RETRY_WAIT_CAP_MS + 1)],
    ["no stated delay", rateLimited(undefined)],
    [
      "a failure that is not a rate limit",
      new ProviderCallError({
        model: { provider: "google", keySource: "byok" },
        status: 502,
        kind: "provider_unavailable",
        retryAfterMs: 5,
      }),
    ],
    ["an application error", new Error("not a provider failure")],
  ] as const) {
    test(`${name}: no wait, no second call`, async () => {
      const call = scripted([failure]);
      const outcome = await Result.tryPromise({
        try: async () => await withProviderRetryWait(undefined, call.run),
        catch: (error: unknown) => error,
      });
      expect(call.calls).toHaveLength(1);
      expect(Result.isError(outcome) && outcome.error).toBe(failure);
    });
  }

  test("a cancellation during the wait ends as a cancelled generation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller left");
    const call = scripted([rateLimited(PROVIDER_RETRY_WAIT_CAP_MS)]);
    const pending = Result.tryPromise({
      try: async () => await withProviderRetryWait(controller.signal, call.run),
      catch: (error: unknown) => error,
    });
    await Bun.sleep(5);
    controller.abort(reason);
    const outcome = await pending;
    expect(call.calls).toHaveLength(1);
    if (!Result.isError(outcome)) {
      return panic("expected the cancelled wait to fail");
    }
    const error = outcome.error;
    if (!(error instanceof HandlerError)) {
      return panic("expected a HandlerError");
    }
    expect(error.cause).toBeInstanceOf(AIGenerationCancelledError);
  });

  test("a deadline during the wait settles as the deadline", async () => {
    const call = scripted([rateLimited(PROVIDER_RETRY_WAIT_CAP_MS)]);
    const outcome = await Result.tryPromise({
      try: async () =>
        await withGenerationDeadline(
          { deadlineMs: 20 },
          async (signal) => await withProviderRetryWait(signal, call.run),
        ),
      catch: (error: unknown) => error,
    });
    expect(call.calls).toHaveLength(1);
    expect(Result.isError(outcome) && outcome.error).toBeInstanceOf(
      ModelDeadlineExceededError,
    );
  });

  test("an SDK error not yet wrapped is read the same way", async () => {
    const sdk = Object.assign(new Error("Too Many Requests"), {
      status: 429,
      headers: new Headers({ "retry-after-ms": "10" }),
    });
    const call = scripted([sdk]);
    expect(await withProviderRetryWait(undefined, call.run)).toBe("answer");
    expect(call.calls).toHaveLength(2);
  });
});

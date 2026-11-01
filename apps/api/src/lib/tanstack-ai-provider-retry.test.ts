import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ModelDeadlineExceededError,
  ProviderCallError,
} from "@/api/lib/errors/provider-call-error";
import { PROVIDER_RETRY_WAIT_CAP_MS } from "@/api/lib/errors/provider-retry-delay";
import {
  isTransientProviderFailure,
  PROVIDER_REQUEST_ATTEMPTS,
  providerBackoffMs,
  providerRetryDelay,
} from "@/api/lib/errors/provider-retry-policy";
import {
  AIGenerationCancelledError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import {
  withGenerationDeadline,
  withProviderRetryWait,
  withProviderStreamRetryWait,
} from "@/api/lib/tanstack-ai-generate";

type FailureOptions = {
  provider?: "anthropic" | "google" | "openai";
  status: number;
  kind: ProviderCallError["kind"];
  retryAfterMs?: number | undefined;
  isRetryable?: boolean | undefined;
};

const providerFailure = ({
  provider = "google",
  status,
  kind,
  retryAfterMs,
  isRetryable,
}: FailureOptions) =>
  new ProviderCallError({
    model: { provider, keySource: "byok" },
    status: 502,
    kind,
    facts: {
      status,
      ...(isRetryable === undefined ? {} : { isRetryable }),
    },
    retryAfterMs,
  });

const rateLimited = (retryAfterMs: number | undefined) =>
  providerFailure({ status: 429, kind: "quota_exhausted", retryAfterMs });

// A call that fails with each queued failure in turn, then answers.
const scripted = (failures: Error[]) => {
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

const settle = async <T>(run: () => Promise<T>) =>
  await Result.tryPromise({
    try: run,
    catch: (error: unknown) => error,
  });

const gapsOf = (calls: readonly number[]) =>
  calls.slice(1).map((at, index) => at - (calls[index] ?? at));

// What each provider SDK retried before Stella turned SDK retries off, and
// what it did not: the generation layer must decide each the same way.
const TRANSIENT = [
  ["a rate limit without a stated delay", rateLimited(undefined)],
  [
    "a provider outage",
    providerFailure({ status: 503, kind: "provider_unavailable" }),
  ],
  ["a request timeout", providerFailure({ status: 408, kind: "unknown" })],
  [
    "a lock timeout from an SDK that retried it",
    providerFailure({ provider: "openai", status: 409, kind: "unknown" }),
  ],
  [
    "a connection failure",
    Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
    }),
  ],
  [
    "a request timeout an SDK raised",
    Object.assign(new Error("Request timed out."), {
      name: "APIConnectionTimeoutError",
    }),
  ],
  [
    "a network reset",
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  ],
  [
    "a status the provider asked to retry",
    providerFailure({ status: 400, kind: "unknown", isRetryable: true }),
  ],
  [
    "an SDK error not yet wrapped",
    Object.assign(new Error("Service Unavailable"), { status: 503 }),
  ],
] as const;

const PERMANENT = [
  [
    "a billing refusal",
    providerFailure({ status: 402, kind: "provider_billing" }),
  ],
  [
    "rejected credentials",
    providerFailure({ status: 401, kind: "provider_credentials_rejected" }),
  ],
  [
    "a retired model",
    providerFailure({ status: 404, kind: "model_unavailable" }),
  ],
  ["a bad request", providerFailure({ status: 400, kind: "unknown" })],
  [
    "a lock timeout from an SDK that did not retry it",
    providerFailure({ provider: "google", status: 409, kind: "unknown" }),
  ],
  [
    "an outage the provider said not to retry",
    providerFailure({
      status: 503,
      kind: "provider_unavailable",
      isRetryable: false,
    }),
  ],
  [
    "a stream that ended early",
    providerFailure({ status: 200, kind: "provider_stream_incomplete" }),
  ],
  ["an application error", new Error("not a provider failure")],
  [
    "a cancellation",
    Object.assign(new Error("aborted"), { name: "AbortError" }),
  ],
] as const;

describe("which failures are sent again", () => {
  for (const [name, failure] of TRANSIENT) {
    test(`${name} is retried`, () => {
      expect(isTransientProviderFailure(failure)).toBe(true);
    });
  }
  for (const [name, failure] of PERMANENT) {
    test(`${name} is not retried`, () => {
      expect(isTransientProviderFailure(failure)).toBe(false);
      expect(
        providerRetryDelay({ error: failure, retries: 0, random: 0 }),
      ).toBeUndefined();
    });
  }

  test("an attempt is never sent past the SDKs' default count", () => {
    expect(PROVIDER_REQUEST_ATTEMPTS).toBe(3);
    const failure = rateLimited(undefined);
    expect(
      providerRetryDelay({ error: failure, retries: 1, random: 0 }),
    ).toBeDefined();
    expect(
      providerRetryDelay({ error: failure, retries: 2, random: 0 }),
    ).toBeUndefined();
  });

  test("a stated delay is waited out, up to the cap", () => {
    expect(
      providerRetryDelay({ error: rateLimited(1200), retries: 0, random: 0.5 }),
    ).toBe(1200);
    expect(
      providerRetryDelay({
        error: rateLimited(PROVIDER_RETRY_WAIT_CAP_MS + 1),
        retries: 0,
        random: 0.5,
      }),
    ).toBeUndefined();
  });

  test("an unstated delay follows the SDK backoff within its bounds", () => {
    for (let retry = 0; retry < 12; retry += 1) {
      const longest = Math.min(500 * 2 ** retry, 8000);
      for (const random of [0, 0.25, 0.5, 0.999]) {
        const delay = providerBackoffMs(retry, random);
        expect(delay).toBeLessThanOrEqual(longest);
        expect(delay).toBeGreaterThan(longest * 0.75);
      }
    }
  });
});

describe("withProviderRetryWait", () => {
  test("waits out a short stated delay and tries again", async () => {
    const call = scripted([rateLimited(40)]);
    expect(await withProviderRetryWait(undefined, call.run)).toBe("answer");
    expect(call.calls).toHaveLength(2);
    const [gap = 0] = gapsOf(call.calls);
    expect(gap).toBeGreaterThanOrEqual(35);
  });

  test("an outage is retried on the SDK backoff, then answers", async () => {
    const outage = () =>
      providerFailure({ status: 503, kind: "provider_unavailable" });
    const call = scripted([outage(), outage()]);
    expect(
      await withProviderRetryWait(undefined, call.run, { random: () => 0 }),
    ).toBe("answer");
    expect(call.calls).toHaveLength(PROVIDER_REQUEST_ATTEMPTS);
    const [first = 0, second = 0] = gapsOf(call.calls);
    expect(first).toBeGreaterThanOrEqual(490);
    expect(first).toBeLessThan(900);
    expect(second).toBeGreaterThanOrEqual(990);
    expect(second).toBeLessThan(1500);
  });

  test("the last attempt's failure reaches the caller with its delay", async () => {
    const last = rateLimited(5);
    const call = scripted([rateLimited(5), rateLimited(5), last]);
    const outcome = await settle(
      async () => await withProviderRetryWait(undefined, call.run),
    );
    expect(call.calls).toHaveLength(PROVIDER_REQUEST_ATTEMPTS);
    expect(Result.isError(outcome) && outcome.error).toBe(last);
  });

  for (const [name, failure] of [
    ["a delay past the cap", rateLimited(PROVIDER_RETRY_WAIT_CAP_MS + 1)],
    ...PERMANENT,
  ] as const) {
    test(`${name}: no wait, no second call`, async () => {
      const call = scripted([failure]);
      const outcome = await settle(
        async () => await withProviderRetryWait(undefined, call.run),
      );
      expect(call.calls).toHaveLength(1);
      expect(Result.isError(outcome) && outcome.error).toBe(failure);
    });
  }

  test("a cancellation during the wait ends as a cancelled generation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller left");
    const call = scripted([rateLimited(PROVIDER_RETRY_WAIT_CAP_MS)]);
    const pending = settle(
      async () => await withProviderRetryWait(controller.signal, call.run),
    );
    await Bun.sleep(5);
    controller.abort(reason);
    const outcome = await pending;
    expect(call.calls).toHaveLength(1);
    const error = Result.isError(outcome) ? outcome.error : undefined;
    expect(error).toBeInstanceOf(HandlerError);
    expect(
      error instanceof HandlerError ? error.cause : undefined,
    ).toBeInstanceOf(AIGenerationCancelledError);
  });

  test("a wait the deadline cannot cover is skipped and the refusal keeps its delay", async () => {
    const refusal = rateLimited(PROVIDER_RETRY_WAIT_CAP_MS);
    const call = scripted([refusal]);
    const started = performance.now();
    const outcome = await settle(
      async () =>
        await withGenerationDeadline(
          { deadlineMs: 2000 },
          async (signal, deadlineAt) =>
            await withProviderRetryWait(signal, call.run, { deadlineAt }),
        ),
    );
    expect(call.calls).toHaveLength(1);
    expect(Result.isError(outcome) && outcome.error).toBe(refusal);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a wait the deadline covers still runs again", async () => {
    const call = scripted([rateLimited(20)]);
    expect(
      await withGenerationDeadline(
        { deadlineMs: 5000 },
        async (signal, deadlineAt) =>
          await withProviderRetryWait(signal, call.run, { deadlineAt }),
      ),
    ).toBe("answer");
    expect(call.calls).toHaveLength(2);
  });

  test("a deadline during the wait settles as the deadline", async () => {
    const call = scripted([rateLimited(PROVIDER_RETRY_WAIT_CAP_MS)]);
    const outcome = await settle(
      async () =>
        await withGenerationDeadline(
          { deadlineMs: 20 },
          async (signal) => await withProviderRetryWait(signal, call.run),
        ),
    );
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

type Item =
  | { type: "start" }
  | { type: "text"; text: string }
  | { type: "error"; failure: Error };

const isStart = (item: Item) => item.type === "start";
const failureOf = (item: Item) =>
  item.type === "error" ? item.failure : undefined;

/** Streams that each run its script in turn; a thrown entry throws there. */
const scriptedStreams = (scripts: (Item | Error)[][]) => {
  let opened = 0;
  const open = async function* (): AsyncIterable<Item> {
    const script = scripts[opened] ?? [];
    opened += 1;
    for (const entry of script) {
      if (entry instanceof Error) {
        throw entry;
      }
      yield entry;
    }
  };
  return { open, opened: () => opened };
};

const collect = async (stream: AsyncIterable<Item>) => {
  const items: Item[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
};

const start: Item = { type: "start" };
const text = (value: string): Item => ({ type: "text", text: value });

describe("withProviderStreamRetryWait", () => {
  test("a stream that fails before its output is opened again, and the caller sees one run", async () => {
    const streams = scriptedStreams([
      [start, rateLimited(1)],
      [start, { type: "error", failure: rateLimited(1) }],
      [start, text("answer")],
    ]);
    const items = await collect(
      withProviderStreamRetryWait({
        abortSignal: undefined,
        open: streams.open,
        isPreamble: isStart,
        failureOf,
      }),
    );
    expect(streams.opened()).toBe(PROVIDER_REQUEST_ATTEMPTS);
    expect(items).toEqual([start, text("answer")]);
  });

  test("a failure after output reaches the caller and nothing is sent again", async () => {
    const failure = rateLimited(1);
    const streams = scriptedStreams([[start, text("partial"), failure]]);
    const items: Item[] = [];
    const outcome = await settle(async () => {
      for await (const item of withProviderStreamRetryWait({
        abortSignal: undefined,
        open: streams.open,
        isPreamble: isStart,
        failureOf,
      })) {
        items.push(item);
      }
    });
    expect(streams.opened()).toBe(1);
    expect(items).toEqual([start, text("partial")]);
    expect(Result.isError(outcome) && outcome.error).toBe(failure);
  });

  test("an in-band failure that is not retried arrives in-band with the rest of the run", async () => {
    const refusal: Item = {
      type: "error",
      failure: providerFailure({ status: 400, kind: "unknown" }),
    };
    const streams = scriptedStreams([[start, refusal, text("after")]]);
    const items = await collect(
      withProviderStreamRetryWait({
        abortSignal: undefined,
        open: streams.open,
        isPreamble: isStart,
        failureOf,
      }),
    );
    expect(streams.opened()).toBe(1);
    expect(items).toEqual([start, refusal, text("after")]);
  });

  test("the attempts are bounded: the last failure reaches the caller", async () => {
    const last: Item = { type: "error", failure: rateLimited(1) };
    const streams = scriptedStreams([
      [start, { type: "error", failure: rateLimited(1) }],
      [start, { type: "error", failure: rateLimited(1) }],
      [start, last],
      [start, text("never sent")],
    ]);
    const items = await collect(
      withProviderStreamRetryWait({
        abortSignal: undefined,
        open: streams.open,
        isPreamble: isStart,
        failureOf,
      }),
    );
    expect(streams.opened()).toBe(PROVIDER_REQUEST_ATTEMPTS);
    expect(items).toEqual([start, last]);
  });

  test("a run cancelled as its request fails is not opened again", async () => {
    const controller = new AbortController();
    const failure = rateLimited(1);
    let opened = 0;
    const open = async function* (): AsyncIterable<Item> {
      opened += 1;
      yield start;
      controller.abort(new Error("caller left"));
      throw failure;
    };
    const outcome = await settle(
      async () =>
        await collect(
          withProviderStreamRetryWait({
            abortSignal: controller.signal,
            open,
            isPreamble: isStart,
            failureOf,
          }),
        ),
    );
    expect(opened).toBe(1);
    expect(Result.isError(outcome) && outcome.error).toBe(failure);
  });
});

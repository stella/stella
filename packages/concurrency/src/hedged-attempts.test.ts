import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { hedgedAttempts } from "./hedged-attempts";

const HEDGE_AFTER_MS = 60_000;
const MAX_RETRIES = 2;

class LostResponseError extends Error {
  override name = "LostResponseError";
}

/** Attempts the test answers by hand, and confirmation timers it fires. */
const createOperation = () => {
  const attempts: PromiseWithResolvers<Response>[] = [];
  const timers: { ms: number; fire: () => void; signal: AbortSignal }[] = [];
  const settled = async () => {
    // Let the operation take what was answered and start what follows.
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
  };
  const late: Response[] = [];
  const sent = hedgedAttempts({
    attempt: async () => {
      const attempt = Promise.withResolvers<Response>();
      attempts.push(attempt);
      return await attempt.promise;
    },
    hedgeAfterMs: HEDGE_AFTER_MS,
    isLost: (error) => error instanceof LostResponseError,
    maxRetries: MAX_RETRIES,
    onLateAnswer: (answer) => {
      late.push(answer);
    },
    wait: async (ms, signal) => {
      const timer = Promise.withResolvers<undefined>();
      timers.push({ ms, fire: () => timer.resolve(undefined), signal });
      await timer.promise;
    },
  });
  return {
    attempts,
    late,
    /** The confirmation timer of the latest attempt fires. */
    unconfirmed: async () => {
      timers.findLast(({ signal }) => !signal.aborted)?.fire();
      await settled();
    },
    answer: async (index: number, response: Response) => {
      attempts[index]?.resolve(response);
      await settled();
    },
    lose: async (index: number) => {
      attempts[index]?.reject(new LostResponseError("connection lost"));
      await settled();
    },
    outcome: async () => await sent,
    settled,
    timers,
  };
};

const streamed = () => new Response("data: {}\n\n", { status: 200 });

describe("an operation whose answer is lost", () => {
  test("is sent again at once after a connection error, and the answer that arrives is the operation's", async () => {
    const operation = createOperation();
    await operation.settled();
    await operation.lose(0);
    expect(operation.attempts).toHaveLength(2);
    const response = streamed();
    await operation.answer(1, response);
    expect(await operation.outcome()).toEqual(Result.ok(response));
  });

  test("with no answer within the confirmation time is asked again, and the first attempt keeps running", async () => {
    const operation = createOperation();
    await operation.settled();
    expect(operation.timers.at(0)?.ms).toBe(HEDGE_AFTER_MS);
    await operation.unconfirmed();
    expect(operation.attempts).toHaveLength(2);
    // The first attempt answers after all: it is the answer, and the
    // retry's late answer goes to the caller.
    const first = streamed();
    await operation.answer(0, first);
    expect(await operation.outcome()).toEqual(Result.ok(first));
    const late = streamed();
    await operation.answer(1, late);
    expect(operation.late).toEqual([late]);
  });

  test(`is sent at most ${String(MAX_RETRIES)} more times, then fails with the last loss`, async () => {
    const operation = createOperation();
    await operation.settled();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await operation.lose(attempt);
    }
    expect(operation.attempts).toHaveLength(MAX_RETRIES + 1);
    const outcome = await operation.outcome();
    expect(Result.isError(outcome) && outcome.error.type).toBe("lost");
    expect(Result.isError(outcome) && outcome.error.error).toBeInstanceOf(
      LostResponseError,
    );
  });

  test("waits for its last attempt without asking again", async () => {
    const operation = createOperation();
    await operation.settled();
    for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
      await operation.unconfirmed();
    }
    expect(operation.attempts).toHaveLength(MAX_RETRIES + 1);
    await operation.unconfirmed();
    expect(operation.attempts).toHaveLength(MAX_RETRIES + 1);
    const refusal = new Response("{}", { status: 409 });
    await operation.answer(MAX_RETRIES, refusal);
    expect(await operation.outcome()).toEqual(Result.ok(refusal));
  });
});

describe("an operation whose answer arrives", () => {
  test("is not sent again when it is a refusal", async () => {
    const operation = createOperation();
    await operation.settled();
    const refusal = new Response("{}", { status: 409 });
    await operation.answer(0, refusal);
    expect(await operation.outcome()).toEqual(Result.ok(refusal));
    expect(operation.attempts).toHaveLength(1);
    expect(operation.timers.every(({ signal }) => signal.aborted)).toBe(true);
  });

  test("ends when the caller aborts it, without another attempt", async () => {
    const operation = createOperation();
    await operation.settled();
    const stopped = new DOMException("Stopped", "AbortError");
    operation.attempts[0]?.reject(stopped);
    await operation.settled();
    expect(await operation.outcome()).toEqual(
      Result.err({ type: "ended", error: stopped }),
    );
    expect(operation.attempts).toHaveLength(1);
  });
});

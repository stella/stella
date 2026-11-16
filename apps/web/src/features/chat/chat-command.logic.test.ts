import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CHAT_COMMAND_CONFIRMATION_MS,
  CHAT_COMMAND_MAX_RETRIES,
} from "@stll/api-contract/chat-command";

import { sendChatCommandAttempts } from "@/features/chat/chat-command.logic";

class LostResponseError extends Error {
  override name = "LostResponseError";
}

/** Attempts the test answers by hand, and confirmation timers it fires. */
const createCommand = () => {
  const attempts: PromiseWithResolvers<Response>[] = [];
  const timers: { ms: number; fire: () => void; signal: AbortSignal }[] = [];
  const settled = async () => {
    // Let the command take what was answered and start what follows.
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve();
    }
  };
  const sent = sendChatCommandAttempts({
    attempt: async () => {
      const attempt = Promise.withResolvers<Response>();
      attempts.push(attempt);
      return await attempt.promise;
    },
    isLostResponse: (error) => error instanceof LostResponseError,
    wait: async (ms, signal) => {
      const timer = Promise.withResolvers<undefined>();
      timers.push({ ms, fire: () => timer.resolve(undefined), signal });
      await timer.promise;
    },
  });
  return {
    attempts,
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
    outcome: async () =>
      await Result.tryPromise({
        try: async () => await sent,
        catch: (error) => error,
      }),
    settled,
    timers,
  };
};

const streamed = () => new Response("data: {}\n\n", { status: 200 });

describe("a member's command whose response is lost", () => {
  test("is sent again at once after a connection error, and the answer that arrives is the command's", async () => {
    const command = createCommand();
    await command.settled();
    await command.lose(0);
    expect(command.attempts).toHaveLength(2);
    const response = streamed();
    await command.answer(1, response);
    expect(await command.outcome()).toEqual(Result.ok(response));
  });

  test("with no answer within the confirmation time is asked again, and the first attempt keeps running", async () => {
    const command = createCommand();
    await command.settled();
    expect(command.timers.at(0)?.ms).toBe(CHAT_COMMAND_CONFIRMATION_MS);
    await command.unconfirmed();
    expect(command.attempts).toHaveLength(2);
    // The first attempt answers after all: it is the command's answer, and
    // the retry's late answer releases its stream.
    const first = streamed();
    await command.answer(0, first);
    expect(await command.outcome()).toEqual(Result.ok(first));
    let released = false;
    const late = new Response(
      new ReadableStream({
        cancel: () => {
          released = true;
        },
      }),
    );
    await command.answer(1, late);
    expect(released).toBe(true);
  });

  test(`is sent at most ${String(CHAT_COMMAND_MAX_RETRIES)} more times, then fails with the last loss`, async () => {
    const command = createCommand();
    await command.settled();
    for (let attempt = 0; attempt <= CHAT_COMMAND_MAX_RETRIES; attempt += 1) {
      await command.lose(attempt);
    }
    expect(command.attempts).toHaveLength(CHAT_COMMAND_MAX_RETRIES + 1);
    const outcome = await command.outcome();
    expect(Result.isError(outcome) && outcome.error).toBeInstanceOf(
      LostResponseError,
    );
  });

  test("waits for its last attempt without asking again", async () => {
    const command = createCommand();
    await command.settled();
    for (let retry = 0; retry < CHAT_COMMAND_MAX_RETRIES; retry += 1) {
      await command.unconfirmed();
    }
    expect(command.attempts).toHaveLength(CHAT_COMMAND_MAX_RETRIES + 1);
    await command.unconfirmed();
    expect(command.attempts).toHaveLength(CHAT_COMMAND_MAX_RETRIES + 1);
    const refusal = new Response("{}", { status: 409 });
    await command.answer(CHAT_COMMAND_MAX_RETRIES, refusal);
    expect(await command.outcome()).toEqual(Result.ok(refusal));
  });
});

describe("a member's command whose response arrives", () => {
  test("is not sent again when it is a refusal", async () => {
    const command = createCommand();
    await command.settled();
    const refusal = new Response("{}", { status: 409 });
    await command.answer(0, refusal);
    expect(await command.outcome()).toEqual(Result.ok(refusal));
    expect(command.attempts).toHaveLength(1);
    expect(command.timers.every(({ signal }) => signal.aborted)).toBe(true);
  });

  test("ends when the member stops it, without another attempt", async () => {
    const command = createCommand();
    await command.settled();
    const stopped = new DOMException("Stopped", "AbortError");
    command.attempts[0]?.reject(stopped);
    await command.settled();
    expect(await command.outcome()).toEqual(Result.err(stopped));
    expect(command.attempts).toHaveLength(1);
  });
});

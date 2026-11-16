import { panic } from "better-result";

import {
  CHAT_COMMAND_CONFIRMATION_MS,
  CHAT_COMMAND_MAX_RETRIES,
} from "@stll/api-contract/chat-command";

import { detached } from "@/lib/detached";

/** How one attempt of a command ended. */
type AttemptEnd = { index: number } & (
  | { type: "answered"; response: Response }
  | { type: "lost"; error: unknown }
  | { type: "ended"; error: unknown }
);

type ChatCommandAttemptsOptions = {
  /**
   * One attempt of the command, under its one id: resolves with the response
   * that arrived (a refusal included), rejects when none did.
   */
  attempt: () => Promise<Response>;
  /**
   * Whether a rejection lost the response (a connection error, a timeout),
   * which is retried, rather than ending the command (the member stopped it).
   */
  isLostResponse: (error: unknown) => boolean;
  /** Resolves after `ms` unless `signal` is aborted first. */
  wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
};

const waitUnlessAborted = async (ms: number, signal: AbortSignal) => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
};

/** A late answer of an attempt nobody reads any more releases its stream. */
const releaseLateAnswers = (
  pending: ReadonlyMap<number, Promise<AttemptEnd>>,
) => {
  for (const end of pending.values()) {
    const release = async () => {
      const ended = await end;
      if (ended.type === "answered") {
        await ended.response.body?.cancel();
      }
    };
    detached(release(), "chat-command.release-late-answer");
  }
};

/**
 * Send a member's command (a send, an answer) until a response arrives, under
 * the id it carries on every attempt (`@stll/api-contract/chat-command`).
 *
 * An attempt whose response is lost (a connection error) is followed by the
 * next one at once; one with no answer within `CHAT_COMMAND_CONFIRMATION_MS`
 * is followed by the next one too, but left running, since abandoning a
 * request the server is still preparing would stop the turn it accepted. At
 * most `CHAT_COMMAND_MAX_RETRIES` attempts follow the first. The first
 * response that arrives is the command's answer, whichever attempt it came
 * from: the server's receipt makes every other attempt a replay of it. A
 * rejection that is not a lost response (the member stopped) ends the
 * command. When every attempt lost its response, the last loss is thrown.
 */
export const sendChatCommandAttempts = async ({
  attempt,
  isLostResponse,
  wait = waitUnlessAborted,
}: ChatCommandAttemptsOptions): Promise<Response> => {
  const pending = new Map<number, Promise<AttemptEnd>>();
  let started = 0;
  let lastLoss: unknown = undefined;
  const start = () => {
    const index = started;
    started += 1;
    pending.set(
      index,
      attempt().then(
        (response): AttemptEnd => ({ index, type: "answered", response }),
        (error: unknown): AttemptEnd => ({
          index,
          type: isLostResponse(error) ? "lost" : "ended",
          error,
        }),
      ),
    );
  };
  const mayRetry = () => started <= CHAT_COMMAND_MAX_RETRIES;
  start();
  while (pending.size > 0) {
    const confirmation = new AbortController();
    const unconfirmed = mayRetry()
      ? [
          wait(CHAT_COMMAND_CONFIRMATION_MS, confirmation.signal).then(
            () => ({ type: "unconfirmed" }) as const,
          ),
        ]
      : [];
    const next = await Promise.race([...pending.values(), ...unconfirmed]);
    confirmation.abort();
    if (next.type === "unconfirmed") {
      start();
      continue;
    }
    pending.delete(next.index);
    switch (next.type) {
      case "answered":
        releaseLateAnswers(pending);
        return next.response;
      case "ended":
        releaseLateAnswers(pending);
        throw next.error;
      case "lost":
        lastLoss = next.error;
        if (mayRetry()) {
          start();
        }
        break;
      default:
        next satisfies never;
        return panic("Unhandled chat command attempt end");
    }
  }
  throw lastLoss;
};

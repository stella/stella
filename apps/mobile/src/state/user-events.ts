import { Result } from "better-result";

import { parseUserRealtimeEvent } from "@stll/api-contract";
import type { UserRealtimeEvent } from "@stll/api-contract";

import { SignedOutError } from "@/connection/errors";
import type { AccessTokenSource } from "@/connection/session";
import { ApiRequestError, withAccessToken } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { createSseParser } from "@/state/chat-stream";
import type { StreamFetch } from "@/state/chat-stream";

/**
 * The person's own event stream. Its events carry no content ("your chats'
 * runs changed"); the app re-reads what changed through the ordinary routes.
 */
const USER_EVENTS_PATH = "/v1/notifications/events";

/** Waiting longer than this for the stream to answer means the connection is gone. */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The server writes a heartbeat every 15 seconds while it has nothing to
 * say, so a minute without a byte means the connection died unnoticed.
 */
const SILENCE_TIMEOUT_MS = 60_000;

/**
 * Reads the person's event stream until it ends, breaks, or `signal` aborts
 * (which ends it without an error). `onOpen` runs once the server accepted
 * the stream, before any event; events this build does not know are skipped.
 */
export const readUserEvents = async ({
  fetch,
  onEvent,
  onOpen,
  signal,
  source,
}: {
  readonly fetch: StreamFetch;
  readonly onEvent: (event: UserRealtimeEvent) => void;
  readonly onOpen: () => void;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
}): Promise<Result<void, ApiError>> => {
  const session = source.session();
  if (session === undefined) {
    return Result.err(
      new SignedOutError({ message: "The session is no longer current" }),
    );
  }
  const url = `${session.serverUrl}${USER_EVENTS_PATH}`;
  return await withAccessToken(source, async (token) => {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener("abort", abort);
    let timer = setTimeout(abort, CONNECT_TIMEOUT_MS);
    const heard = () => {
      clearTimeout(timer);
      timer = setTimeout(abort, SILENCE_TIMEOUT_MS);
    };
    const read = await Result.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
          return response.status;
        }
        heard();
        onOpen();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parse = createSseParser();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          heard();
          for (const { data } of parse(
            decoder.decode(chunk.value, { stream: true }),
          )) {
            const event = parseUserRealtimeEvent(parseJson(data));
            if (event !== null) {
              onEvent(event);
            }
          }
        }
        return response.status;
      },
      catch: (cause) =>
        new ApiRequestError({ message: `The stream from ${url} broke`, cause }),
    });
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (Result.isError(read)) {
      return signal.aborted ? Result.ok(undefined) : Result.err(read.error);
    }
    const status = read.value;
    return status >= 200 && status < 300
      ? Result.ok(undefined)
      : Result.err(
          new ApiRequestError({
            message: `The request to ${url} responded ${status}`,
            status,
          }),
        );
  });
};

/** An event's data as JSON, or undefined when it is not JSON at all. */
const parseJson = (data: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(data));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

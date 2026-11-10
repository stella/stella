import { useEffect, useEffectEvent, useRef, useState } from "react";

import { panic, Result } from "better-result";
import { fetch as streamingFetch } from "expo/fetch";
import { AppState } from "react-native";

import { REALTIME_EVENT_TYPE } from "@stll/api-contract";
import type { UserRealtimeEvent } from "@stll/api-contract";
import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { sleep } from "@stll/concurrency/sleep";

import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { listActiveChatRuns } from "@/state/chat-runs";
import type { ActiveRunsState } from "@/state/chat-runs";
import { readUserEvents } from "@/state/user-events";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The person's unfinished chat runs, kept fresh without polling: read each
 * time their event stream opens (once anyway if it cannot), and again
 * whenever it says the runs changed. The stream closes while the app is in
 * the background and reopens when it returns.
 * `reread` reads them again now, for pull to refresh and a retry.
 */
export const useActiveChatRuns = (source: AccessTokenSource) => {
  const { end } = useSession();
  const [runs, setRuns] = useState<ActiveRunsState>({ status: "loading" });
  // Each read is numbered; only the newest one's answer is shown.
  const reads = useRef(0);

  const read = async () => {
    reads.current += 1;
    const asked = reads.current;
    const result = await listActiveChatRuns({ fetch, source });
    if (asked !== reads.current) {
      return;
    }
    if (Result.isOk(result)) {
      setRuns({ status: "loaded", runs: result.value });
      return;
    }
    if (result.error._tag === "SignedOutError") {
      end(source);
      return;
    }
    setRuns({ status: "failed", error: result.error });
  };
  const reread = () => {
    void read();
  };

  const onEvent = useEffectEvent(({ type: eventType }: UserRealtimeEvent) => {
    switch (eventType) {
      case REALTIME_EVENT_TYPE.CHAT_RUNS_CHANGED:
        reread();
        return;
      // The app hears of notifications through push.
      case REALTIME_EVENT_TYPE.NEW_NOTIFICATION:
        return;
      default:
        eventType satisfies never;
        panic("Unhandled user realtime event");
    }
  });
  const onResync = useEffectEvent(reread);
  const signOut = useEffectEvent(() => {
    end(source);
  });

  useEffect(() => {
    let connection: AbortController | null = null;
    // Whether this screen has asked for the runs at all yet.
    const asked = { runs: false };
    const resync = () => {
      asked.runs = true;
      onResync();
    };
    // Every open reads the runs: events sent while no stream was open are
    // lost, and the first open is this screen's first read.
    const attempt = async (signal: AbortSignal) => {
      let heard = false;
      const ended = await readUserEvents({
        fetch: streamingFetch,
        onEvent: (event) => {
          onEvent(event);
        },
        onOpen: () => {
          heard = true;
          resync();
        },
        signal,
        source,
      });
      return { ended, heard };
    };
    const follow = async (signal: AbortSignal) => {
      let failures = 0;
      while (!signal.aborted) {
        const { ended, heard } = await attempt(signal);
        // A stream that never opens still owes the screen one read.
        if (!asked.runs) {
          resync();
        }
        failures = heard ? 0 : failures;
        if (Result.isError(ended)) {
          if (ended.error._tag === "SignedOutError") {
            signOut();
            return;
          }
          if (refusesForGood(ended.error)) {
            return;
          }
          failures += 1;
        }
        const delay = backoffDelay(Math.max(0, failures - 1), {
          baseMs: RECONNECT_BASE_MS,
          maxMs: RECONNECT_MAX_MS,
        });
        const waited = await Result.tryPromise(
          async () => await sleep(delay, { signal }),
        );
        if (Result.isError(waited)) {
          return;
        }
      }
    };
    const connect = () => {
      const controller = new AbortController();
      connection = controller;
      void follow(controller.signal);
    };

    connect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && connection === null) {
        connect();
      } else if (state === "background") {
        connection?.abort();
        connection = null;
      }
    });
    return () => {
      subscription.remove();
      connection?.abort();
    };
  }, [source]);

  return { reread, runs };
};

/**
 * A refusal a retry would only repeat: the server does not offer this
 * stream to the app, or not to this sign-in. The runs then stay as last
 * read until the list is refreshed.
 */
const refusesForGood = (error: ApiError): boolean =>
  error._tag === "ApiRequestError" &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { panic, Result } from "better-result";
import { fetch as streamingFetch } from "expo/fetch";
import { AppState } from "react-native";

import { USER_EVENT_READ, USER_EVENT_READS } from "@stll/api-contract";
import type { UserEventRead, UserRealtimeEvent } from "@stll/api-contract";
import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { sleep } from "@stll/concurrency/sleep";

import { useChanged } from "@/components/changes";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import type { ApiError } from "@/state/api-request";
import { listActiveChatRuns } from "@/state/chat-runs";
import type { ActiveChatRun, ActiveRunsState } from "@/state/chat-runs";
import { queueRunBanners } from "@/state/run-banners";
import type { RunBanner } from "@/state/run-banners";
import { readUserEvents } from "@/state/user-events";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

type ActiveChatRuns = {
  readonly runs: ActiveRunsState;
  /** Reads the runs again now, for pull to refresh and a retry. */
  readonly reread: () => void;
  /** News the reads brought, oldest first, one banner per chat at most. */
  readonly banners: readonly RunBanner[];
  /** Puts away the banner for a chat, if one is waiting. */
  readonly dismissBanner: (threadId: string) => void;
};

const ActiveChatRunsContext = createContext<ActiveChatRuns | null>(null);

/**
 * The one reader of the person's unfinished chat runs, above the tabs, so
 * the chats list and the run banners share one event stream and one read
 * per change, whichever tab is open. Signed out, it reads nothing.
 */
export const ActiveChatRunsProvider = ({
  children,
}: React.PropsWithChildren) => {
  const { state } = useSession();
  const runs = useRunsStream(
    state.status === "signed-in" ? state.source : undefined,
  );
  return <ActiveChatRunsContext value={runs}>{children}</ActiveChatRunsContext>;
};

export const useActiveChatRuns = (): ActiveChatRuns =>
  use(ActiveChatRunsContext) ??
  panic("useActiveChatRuns needs an ActiveChatRunsProvider above it");

/** What one sign-in has read of its runs. */
type Reading = {
  readonly source: AccessTokenSource | undefined;
  readonly runs: ActiveRunsState;
  /** The runs the next read is compared with; none means it only sets them. */
  readonly baseline: readonly ActiveChatRun[] | undefined;
  readonly banners: readonly RunBanner[];
};

const LOADING: ActiveRunsState = { status: "loading" };
const NO_BANNERS: readonly RunBanner[] = [];

const unread = (source: AccessTokenSource | undefined): Reading => ({
  banners: NO_BANNERS,
  baseline: undefined,
  runs: LOADING,
  source,
});

/**
 * The person's unfinished chat runs, kept fresh without polling: read each
 * time their event stream opens (once anyway if it cannot), and again
 * whenever it says the runs changed; what else an event makes it read
 * again, the chats lists among them, is the contract's USER_EVENT_READS.
 * The stream closes while the app is in the background and reopens when it
 * returns. Each read is compared with the one before for banners; the first read after the app returns from
 * the background only sets what later reads are compared with, so what
 * happened meanwhile is left to the chats list and push. What was read
 * belongs to the sign-in that read it: another sign-in, or none, starts
 * from nothing, so a read still on its way never shows under the next one.
 */
const useRunsStream = (
  source: AccessTokenSource | undefined,
): ActiveChatRuns => {
  const { end } = useSession();
  const changed = useChanged();
  const [stored, setReading] = useState(() => unread(source));
  const reading = stored.source === source ? stored : unread(source);
  /** Changes what this sign-in has read, from scratch if it read nothing yet. */
  const update = (change: (current: Reading) => Reading) => {
    setReading((current) =>
      change(current.source === source ? current : unread(source)),
    );
  };
  // Each read is numbered; only the newest one's answer is shown.
  const reads = useRef(0);

  const read = async () => {
    if (source === undefined) {
      return;
    }
    reads.current += 1;
    const asked = reads.current;
    const result = await listActiveChatRuns({ fetch, source });
    if (asked !== reads.current) {
      return;
    }
    if (Result.isOk(result)) {
      const next = result.value;
      update(({ banners, baseline }) => ({
        banners: queueRunBanners({ next, previous: baseline, queue: banners }),
        baseline: next,
        runs: { status: "loaded", runs: next },
        source,
      }));
      return;
    }
    if (result.error._tag === "SignedOutError") {
      end(source);
      return;
    }
    const { error } = result;
    update(({ banners, baseline }) => ({
      banners,
      baseline,
      runs: { status: "failed", error },
      source,
    }));
  };
  const reread = () => {
    void read();
  };
  const dismissBanner = (threadId: string) => {
    update((current) =>
      current.banners.some((banner) => banner.threadId === threadId)
        ? {
            banners: current.banners.filter(
              (banner) => banner.threadId !== threadId,
            ),
            baseline: current.baseline,
            runs: current.runs,
            source: current.source,
          }
        : current,
    );
  };
  const forgetBaseline = useEffectEvent(() => {
    update(({ runs }) => ({
      banners: NO_BANNERS,
      baseline: undefined,
      runs,
      source,
    }));
  });

  const readsAgain = {
    [USER_EVENT_READ.ACTIVE_CHAT_RUNS]: reread,
    [USER_EVENT_READ.CHAT_THREADS]: () => {
      changed("chats");
    },
    // The app hears of notifications through push.
    [USER_EVENT_READ.NOTIFICATIONS]: () => undefined,
    // Read by an open chat's own background count, not by this list.
    [USER_EVENT_READ.CHAT_BACKGROUND_TASKS]: () => undefined,
  } satisfies Record<UserEventRead, () => void>;
  const onEvent = useEffectEvent(({ type }: UserRealtimeEvent) => {
    for (const stale of USER_EVENT_READS[type]) {
      readsAgain[stale]();
    }
  });
  const onResync = useEffectEvent(reread);
  const onReopen = useEffectEvent(() => {
    changed("chats");
  });
  const signOut = useEffectEvent((refused: AccessTokenSource) => {
    end(refused);
  });

  useEffect(() => {
    if (source === undefined) {
      return undefined;
    }
    let connection: AbortController | null = null;
    // Whether this sign-in has asked for the runs at all yet.
    const asked = { runs: false };
    // Whether its stream has opened before: chats marked while it was
    // closed sent events no one heard, so a later open reads them again.
    const stream = { opened: false };
    const resync = () => {
      asked.runs = true;
      onResync();
    };
    // Every open reads the runs: events sent while no stream was open are
    // lost, and the first open is this sign-in's first read.
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
          if (stream.opened) {
            onReopen();
          }
          stream.opened = true;
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
        // A stream that never opens still owes the sign-in one read.
        if (!asked.runs) {
          resync();
        }
        failures = heard ? 0 : failures;
        if (Result.isError(ended)) {
          if (ended.error._tag === "SignedOutError") {
            signOut(source);
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
        forgetBaseline();
      }
    });
    return () => {
      subscription.remove();
      connection?.abort();
    };
  }, [source]);

  return {
    banners: reading.banners,
    dismissBanner,
    reread,
    runs: reading.runs,
  };
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

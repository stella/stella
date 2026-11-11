import { Result } from "better-result";
import * as v from "valibot";

import {
  CHAT_ACTIVE_RUN_STATE,
  CHAT_THREAD_PIN_STATE,
} from "@stll/api-contract/chat";
import type { ChatActiveRunState } from "@stll/api-contract/chat";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { ApiRequestError, requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { sectionThreads, threadDay } from "@/state/chat-threads";
import type {
  ChatThreadHeading,
  ChatThreadSection,
  ChatThreadSummary,
} from "@/state/chat-threads";

/** The person's unfinished chat runs, waiting on them first; the app's chat scope opens it. */
const ACTIVE_RUNS_PATH = "/v1/chat/runs/active";
const ACTIVE_RUNS_PAGE_SIZE = 100;

const RUN_STATES: readonly string[] = Object.values(CHAT_ACTIVE_RUN_STATE);

const isRunState = (state: string): state is ChatActiveRunState =>
  RUN_STATES.includes(state);

const runSchema = v.object({
  threadId: v.pipe(v.string(), v.minLength(1)),
  threadTitle: v.string(),
  workspaceId: v.nullable(v.pipe(v.string(), v.minLength(1))),
  // Read as text: a state a newer server adds is one this build cannot
  // draw, so its run is left out rather than failing the whole read.
  state: v.string(),
  since: v.pipe(v.string(), v.isoTimestamp()),
});

const runsPageSchema = v.object({
  items: v.array(runSchema),
  nextCursor: v.nullable(v.string()),
});

/** One unfinished run: the thread it belongs to and where it stands. */
export type ActiveChatRun = {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly matterId: string | undefined;
  readonly state: ChatActiveRunState;
  /** When the run entered its state. */
  readonly since: string;
};

/** The runs this build can draw, in the order the server lists them. */
const knownRuns = (
  items: readonly v.InferOutput<typeof runSchema>[],
): ActiveChatRun[] =>
  items.flatMap(({ since, state, threadId, threadTitle, workspaceId }) =>
    isRunState(state)
      ? [
          {
            matterId: workspaceId ?? undefined,
            since,
            state,
            threadId,
            threadTitle,
          },
        ]
      : [],
  );

type ListActiveChatRunsArgs = {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
};

type RunsPage = v.InferOutput<typeof runsPageSchema>;

const readRunsPage = async ({
  cursor,
  fetch,
  source,
}: ListActiveChatRunsArgs & {
  readonly cursor: string | null;
}): Promise<Result<RunsPage, ApiError>> =>
  await requestApi({
    fetch,
    path: `${ACTIVE_RUNS_PATH}?limit=${ACTIVE_RUNS_PAGE_SIZE}${
      cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`
    }`,
    schema: runsPageSchema,
    source,
  });

/**
 * Every page of the person's unfinished runs. The server lists waiting runs
 * first, so stopping at one page could hide the working ones. A cursor the
 * server already gave fails the read rather than asking for that page again
 * without end.
 */
export const listActiveChatRuns = async ({
  fetch,
  source,
}: ListActiveChatRunsArgs): Promise<Result<ActiveChatRun[], ApiError>> =>
  await Result.gen(async function* () {
    const runs: ActiveChatRun[] = [];
    const followed = new Set<string>();
    let cursor: string | null = null;
    do {
      if (cursor !== null) {
        if (followed.has(cursor)) {
          return Result.err(
            new ApiRequestError({
              message: "The list of unfinished runs repeated a page cursor.",
            }),
          );
        }
        followed.add(cursor);
      }
      // Typed: the loop reads `cursor` from the page it fetched.
      const page: RunsPage = yield* Result.await(
        readRunsPage({ cursor, fetch, source }),
      );
      runs.push(...knownRuns(page.items));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return Result.ok(runs);
  });

/**
 * What the list knows about the person's unfinished runs: still asking,
 * read (possibly none), or not read, which is never shown as "none".
 */
export type ActiveRunsState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly runs: readonly ActiveChatRun[] }
  | { readonly status: "failed"; readonly error: ApiError };

/**
 * Each thread's run as the app shows it: the first one listed, which the
 * server orders waiting first, so a thread with several runs waits on the
 * person when any of them does. Keyed in listing order.
 */
export const runsByThread = (
  runs: readonly ActiveChatRun[],
): ReadonlyMap<string, ActiveChatRun> => {
  const threads = new Map<string, ActiveChatRun>();
  for (const run of runs) {
    if (!threads.has(run.threadId)) {
      threads.set(run.threadId, run);
    }
  }
  return threads;
};

/**
 * A row of the chats list: the thread, its day, and its open run, if any.
 * A thread the list read says how the reader marked it; one only an open
 * run names, older than the threads loaded so far, does not.
 */
export type InboxThread =
  | {
      readonly type: "listed";
      readonly thread: ChatThreadSummary;
      readonly day: ChatThreadSection["key"];
      readonly runState: ChatActiveRunState | undefined;
    }
  | {
      readonly type: "run-only";
      readonly thread: ChatThreadHeading;
      readonly day: ChatThreadSection["key"];
      readonly runState: ChatActiveRunState;
    };

type InboxSection = {
  readonly key: "needsYou" | "working" | "pinned" | ChatThreadSection["key"];
  readonly data: readonly InboxThread[];
};

/**
 * The chats list as an inbox: chats waiting on the person, then chats
 * working, then the ones they pinned, then the rest under their day
 * headings; each chat once, in the first of these it belongs to. A
 * searched list lifts only threads the search found; an unsearched one
 * lifts every open run, even one older than the threads loaded so far.
 */
export const inboxSections = ({
  now,
  runs,
  searching,
  threads,
  timeZone,
}: {
  readonly now: number;
  readonly runs: readonly ActiveChatRun[];
  readonly searching: boolean;
  readonly threads: readonly ChatThreadSummary[];
  readonly timeZone: string;
}): InboxSection[] => {
  const loaded = new Map(threads.map((thread) => [thread.id, thread]));
  const matterNames = new Map(
    threads.flatMap(({ matterId, matterName }) =>
      matterId === undefined || matterName === undefined
        ? []
        : [[matterId, matterName] as const],
    ),
  );
  const day = (thread: ChatThreadHeading) =>
    threadDay({ now, timeZone, updatedAt: thread.updatedAt });
  const listed = (
    thread: ChatThreadSummary,
    runState?: ChatActiveRunState,
  ): InboxThread => ({ type: "listed", day: day(thread), runState, thread });
  const lifted = new Map<string, InboxThread>();
  for (const run of runsByThread(runs).values()) {
    const known = loaded.get(run.threadId);
    if (known !== undefined) {
      lifted.set(run.threadId, listed(known, run.state));
      continue;
    }
    if (searching) {
      continue;
    }
    const thread = {
      id: run.threadId,
      title: run.threadTitle,
      updatedAt: run.since,
      matterId: run.matterId,
      matterName:
        run.matterId === undefined ? undefined : matterNames.get(run.matterId),
    };
    lifted.set(run.threadId, {
      type: "run-only",
      day: day(thread),
      runState: run.state,
      thread,
    });
  }
  const inState = (state: ChatActiveRunState) =>
    [...lifted.values()].filter(({ runState }) => runState === state);
  const left = threads.filter((thread) => !lifted.has(thread.id));
  const lead = [
    { key: "needsYou", data: inState(CHAT_ACTIVE_RUN_STATE.needsYou) },
    { key: "working", data: inState(CHAT_ACTIVE_RUN_STATE.working) },
    {
      key: "pinned",
      data: left
        .filter(({ pinState }) => pinState === CHAT_THREAD_PIN_STATE.pinned)
        .map((thread) => listed(thread)),
    },
  ] as const satisfies readonly InboxSection[];
  const rest = sectionThreads(
    left.filter(({ pinState }) => pinState === CHAT_THREAD_PIN_STATE.unpinned),
    now,
    timeZone,
  ).map(({ data, key }) => ({
    key,
    data: data.map((thread) => listed(thread)),
  }));
  return [...lead.filter(({ data }) => data.length > 0), ...rest];
};

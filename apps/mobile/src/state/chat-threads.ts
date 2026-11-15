import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  CHAT_THREAD_PIN_STATE,
  CHAT_THREAD_READ_STATE,
} from "@stll/api-contract/chat";
import type {
  ChatThreadPinState,
  ChatThreadReadState,
} from "@stll/api-contract/chat";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** The person's own threads, most recently active first; the API admits the app's chat scope on it. */
const THREADS_PATH = "/v1/chat/threads";

/** Only what a row shows. */
const threadSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.string(),
  updatedAt: v.pipe(v.string(), v.isoTimestamp()),
  readState: v.picklist(Object.values(CHAT_THREAD_READ_STATE)),
  pinState: v.picklist(Object.values(CHAT_THREAD_PIN_STATE)),
});

const threadsPageSchema = v.object({
  global: v.array(threadSchema),
  nextCursor: v.nullable(v.string()),
  workspaces: v.array(
    v.object({
      workspaceId: v.pipe(v.string(), v.minLength(1)),
      workspaceName: v.string(),
      threads: v.array(threadSchema),
    }),
  ),
});

/** A thread as a row names it: a global chat has no matter. */
export type ChatThreadHeading = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly matterId: string | undefined;
  readonly matterName: string | undefined;
};

/** A thread as the list read it, with how the reader marked it. */
export type ChatThreadSummary = ChatThreadHeading & {
  readonly readState: ChatThreadReadState;
  readonly pinState: ChatThreadPinState;
};

type ChatThreadsPage = {
  readonly threads: readonly ChatThreadSummary[];
  readonly nextCursor: string | null;
};

/** Where the pinned list and the rest each continue; null once read to the end. */
export type ChatListCursors = Readonly<
  Record<ChatThreadPinState, string | null>
>;

/** The chats list's first load: its pinned chats, then the rest. */
export type ChatListPage = {
  readonly threads: readonly ChatThreadSummary[];
  readonly cursors: ChatListCursors;
};

/**
 * One page as a single list. The API splits a page into global threads and
 * per-matter groups; the phone shows one timeline, newest first, with the
 * matter as a label.
 */
export const flattenThreadsPage = (
  page: v.InferOutput<typeof threadsPageSchema>,
): ChatThreadsPage => ({
  nextCursor: page.nextCursor,
  threads: [
    ...page.global.map((thread) => ({
      ...thread,
      matterId: undefined,
      matterName: undefined,
    })),
    ...page.workspaces.flatMap((group) =>
      group.threads.map((thread) => ({
        ...thread,
        matterId: group.workspaceId,
        matterName: group.workspaceName,
      })),
    ),
  ].sort(byNewest),
});

const byNewest = (left: ChatThreadSummary, right: ChatThreadSummary) =>
  Temporal.Instant.compare(
    Temporal.Instant.from(right.updatedAt),
    Temporal.Instant.from(left.updatedAt),
  );

/** The threads loaded so far followed by the next page, without a thread twice when one moved between pages. */
export const appendThreadsPage = (
  loaded: readonly ChatThreadSummary[],
  next: readonly ChatThreadSummary[],
): ChatThreadSummary[] => {
  const seen = new Set(loaded.map((thread) => thread.id));
  return [...loaded, ...next.filter((thread) => !seen.has(thread.id))];
};

/**
 * The list's query: only the pinned chats or only the rest, or both when
 * no pin state is named; the text a thread's title or matter must contain,
 * when any is typed; and the page to continue from.
 */
export const threadsQuery = ({
  cursor,
  pinState,
  search,
}: {
  readonly cursor?: string | undefined;
  readonly pinState: ChatThreadPinState | undefined;
  readonly search?: string | undefined;
}): string => {
  const text = search?.trim() ?? "";
  const params = [
    ...(pinState === undefined ? [] : [`pinState=${pinState}`]),
    ...(text === "" ? [] : [`search=${encodeURIComponent(text)}`]),
    ...(cursor === undefined ? [] : [`cursor=${encodeURIComponent(cursor)}`]),
  ];
  return params.length === 0 ? "" : `?${params.join("&")}`;
};

type ListChatsArgs = {
  readonly fetch: Fetch;
  readonly search?: string | undefined;
  readonly source: AccessTokenSource;
};

export const listChatThreads = async ({
  cursor,
  fetch,
  pinState,
  search,
  source,
}: ListChatsArgs & {
  readonly cursor?: string | undefined;
  readonly pinState: ChatThreadPinState | undefined;
}): Promise<Result<ChatThreadsPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${THREADS_PATH}${threadsQuery({ cursor, pinState, search })}`,
        schema: threadsPageSchema,
        source,
      }),
    );
    return Result.ok(flattenThreadsPage(page));
  });

/**
 * The chats list's first load, two reads at once: the first page of pinned
 * chats and the first page of the rest. The server splits them, so no chat
 * is in both; either failing fails the load.
 */
export const listChats = async (
  args: ListChatsArgs,
): Promise<Result<ChatListPage, ApiError>> => {
  const pinnedRead = listChatThreads({
    ...args,
    pinState: CHAT_THREAD_PIN_STATE.pinned,
  });
  const unpinnedRead = listChatThreads({
    ...args,
    pinState: CHAT_THREAD_PIN_STATE.unpinned,
  });
  return await Result.gen(async function* () {
    const pinned = yield* Result.await(pinnedRead);
    const unpinned = yield* Result.await(unpinnedRead);
    return Result.ok({
      cursors: {
        pinned: pinned.nextCursor,
        unpinned: unpinned.nextCursor,
      },
      threads: appendThreadsPage(pinned.threads, unpinned.threads),
    });
  });
};

/** The next page to read, and where the lists continue once it is read. */
type NextChatsPage = {
  readonly cursor: string;
  readonly pinState: ChatThreadPinState;
  readonly after: (nextCursor: string | null) => ChatListCursors;
};

/**
 * Which list the next page continues: the pinned chats before the rest, or
 * neither once both are read to the end.
 */
export const nextChatsPage = ({
  pinned,
  unpinned,
}: ChatListCursors): NextChatsPage | null => {
  if (pinned !== null) {
    return {
      after: (nextCursor) => ({ pinned: nextCursor, unpinned }),
      cursor: pinned,
      pinState: CHAT_THREAD_PIN_STATE.pinned,
    };
  }
  if (unpinned !== null) {
    return {
      after: (nextCursor) => ({ pinned, unpinned: nextCursor }),
      cursor: unpinned,
      pinState: CHAT_THREAD_PIN_STATE.unpinned,
    };
  }
  return null;
};

type ThreadMarkArgs = {
  readonly fetch: Fetch;
  readonly matterId: string | undefined;
  readonly source: AccessTokenSource;
  readonly threadId: string;
};

/** A mark's path; a matter's thread names its matter, or the server refuses it as out of scope. */
const markPath = ({
  matterId,
  mark,
  threadId,
}: Pick<ThreadMarkArgs, "matterId" | "threadId"> & {
  readonly mark: "pin-state" | "read-state";
}) =>
  `${THREADS_PATH}/${encodeURIComponent(threadId)}/${mark}${
    matterId === undefined ? "" : `?workspaceId=${encodeURIComponent(matterId)}`
  }`;

/** Marks a thread read or unread for the reader; the server tells their other devices. */
export const setChatThreadReadState = async ({
  fetch,
  matterId,
  readState,
  source,
  threadId,
}: ThreadMarkArgs & {
  readonly readState: ChatThreadReadState;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { readState },
        fetch,
        method: "PATCH",
        path: markPath({ mark: "read-state", matterId, threadId }),
        // Only whether it succeeded matters; the row already shows the state.
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** Pins a thread to the top of the reader's list, or unpins it. */
export const setChatThreadPinState = async ({
  fetch,
  matterId,
  pinState,
  source,
  threadId,
}: ThreadMarkArgs & {
  readonly pinState: ChatThreadPinState;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { pinState },
        fetch,
        method: "PATCH",
        path: markPath({ mark: "pin-state", matterId, threadId }),
        // Only whether it succeeded matters; the row already shows the state.
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

export type ChatThreadSection = {
  readonly key: (typeof SECTION_ORDER)[number];
  readonly data: readonly ChatThreadSummary[];
};

const SECTION_ORDER = ["today", "yesterday", "week", "earlier"] as const;

const calendarDay = (
  instant: Temporal.Instant,
  timeZone: string,
): Temporal.PlainDate => instant.toZonedDateTimeISO(timeZone).toPlainDate();

/** Which day heading an instant falls under, by the calendar in `timeZone`. */
export const threadDay = ({
  now,
  timeZone,
  updatedAt,
}: {
  readonly now: number;
  readonly timeZone: string;
  readonly updatedAt: string;
}): ChatThreadSection["key"] => {
  const today = calendarDay(
    Temporal.Instant.fromEpochMilliseconds(now),
    timeZone,
  );
  const day = calendarDay(Temporal.Instant.from(updatedAt), timeZone);
  const daysAgo = day.until(today, { largestUnit: "day" }).days;
  if (daysAgo <= 0) {
    return "today";
  }
  if (daysAgo === 1) {
    return "yesterday";
  }
  return daysAgo <= 7 ? "week" : "earlier";
};

/**
 * Threads under Today, Yesterday, Previous 7 days and Earlier, by the
 * calendar in `timeZone`. Empty sections are left out; order within a
 * section is kept.
 */
export const sectionThreads = (
  threads: readonly ChatThreadSummary[],
  now: number,
  timeZone: string,
): ChatThreadSection[] => {
  const buckets = new Map<ChatThreadSection["key"], ChatThreadSummary[]>(
    SECTION_ORDER.map((key) => [key, []]),
  );
  for (const thread of threads) {
    buckets
      .get(threadDay({ now, timeZone, updatedAt: thread.updatedAt }))
      ?.push(thread);
  }
  return SECTION_ORDER.flatMap((key) => {
    const data = buckets.get(key) ?? [];
    return data.length === 0 ? [] : [{ key, data }];
  });
};

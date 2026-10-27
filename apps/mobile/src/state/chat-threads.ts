import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

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

/** A thread as the list shows it: a global chat has no matter. */
export type ChatThreadSummary = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly matterName: string | undefined;
};

export type ChatThreadsPage = {
  readonly threads: readonly ChatThreadSummary[];
  readonly nextCursor: string | null;
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
    ...page.global.map((thread) => ({ ...thread, matterName: undefined })),
    ...page.workspaces.flatMap((group) =>
      group.threads.map((thread) => ({
        ...thread,
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

export const listChatThreads = async ({
  cursor,
  fetch,
  source,
}: {
  readonly cursor?: string | undefined;
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<ChatThreadsPage, ApiError>> =>
  await Result.gen(async function* () {
    const query =
      cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${THREADS_PATH}${query}`,
        schema: threadsPageSchema,
        source,
      }),
    );
    return Result.ok(flattenThreadsPage(page));
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
  const today = calendarDay(
    Temporal.Instant.fromEpochMilliseconds(now),
    timeZone,
  );
  const keyOf = (thread: ChatThreadSummary): ChatThreadSection["key"] => {
    const day = calendarDay(Temporal.Instant.from(thread.updatedAt), timeZone);
    const daysAgo = day.until(today, { largestUnit: "day" }).days;
    if (daysAgo <= 0) {
      return "today";
    }
    if (daysAgo === 1) {
      return "yesterday";
    }
    return daysAgo <= 7 ? "week" : "earlier";
  };
  const buckets = new Map<ChatThreadSection["key"], ChatThreadSummary[]>(
    SECTION_ORDER.map((key) => [key, []]),
  );
  for (const thread of threads) {
    buckets.get(keyOf(thread))?.push(thread);
  }
  return SECTION_ORDER.flatMap((key) => {
    const data = buckets.get(key) ?? [];
    return data.length === 0 ? [] : [{ key, data }];
  });
};

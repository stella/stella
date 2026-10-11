import * as v from "valibot";

import { Temporal, todayFor } from "@stll/time";

import { APIError } from "@/lib/errors/api";

/**
 * The history page's filters live in the URL, so a reader who opens a chat
 * and comes back lands on the same search and matter. A malformed value falls
 * back to no filter instead of failing the route.
 */
export const chatHistorySearchSchema = v.object({
  q: v.fallback(v.optional(v.string()), undefined),
  matter: v.fallback(v.optional(v.string()), undefined),
});

export type ChatHistorySearch = v.InferOutput<typeof chatHistorySearchSchema>;

export const CHAT_HISTORY_PERIOD = {
  today: "today",
  previous7Days: "previous7Days",
  older: "older",
} as const;

export type ChatHistoryPeriod =
  (typeof CHAT_HISTORY_PERIOD)[keyof typeof CHAT_HISTORY_PERIOD];

const PERIOD_ORDER = [
  CHAT_HISTORY_PERIOD.today,
  CHAT_HISTORY_PERIOD.previous7Days,
  CHAT_HISTORY_PERIOD.older,
] as const satisfies readonly ChatHistoryPeriod[];

const PREVIOUS_PERIOD_DAYS = 7;

type ChatHistoryPeriodOptions = {
  now: Temporal.Instant;
  timeZone: string;
  updatedAt: Date | string;
};

/**
 * Which period a chat's last activity falls in, by calendar day in the
 * reader's time zone: "today" is the reader's date, not the last 24 hours,
 * and the previous seven days are the seven dates before it. Activity stamped
 * after `now` (clock skew) still counts as today.
 */
export const chatHistoryPeriod = ({
  now,
  timeZone,
  updatedAt,
}: ChatHistoryPeriodOptions): ChatHistoryPeriod => {
  const today = todayFor(timeZone, now);
  const day = todayFor(
    timeZone,
    Temporal.Instant.fromEpochMilliseconds(new Date(updatedAt).getTime()),
  );
  const daysAgo = day.until(today, { largestUnit: "days" }).days;
  if (daysAgo <= 0) {
    return CHAT_HISTORY_PERIOD.today;
  }
  if (daysAgo <= PREVIOUS_PERIOD_DAYS) {
    return CHAT_HISTORY_PERIOD.previous7Days;
  }
  return CHAT_HISTORY_PERIOD.older;
};

export type ChatHistoryGroup<TItem> = {
  period: ChatHistoryPeriod;
  items: TItem[];
};

type GroupChatHistoryOptions<TItem> = {
  items: readonly TItem[];
  now: Temporal.Instant;
  timeZone: string;
};

/**
 * Splits an already ordered history into period groups, newest period first.
 * Items keep their order inside a group and empty periods are left out.
 */
export const groupChatHistoryByPeriod = <
  TItem extends { updatedAt: Date | string },
>({
  items,
  now,
  timeZone,
}: GroupChatHistoryOptions<TItem>): ChatHistoryGroup<TItem>[] => {
  const byPeriod = new Map<ChatHistoryPeriod, TItem[]>();
  for (const item of items) {
    const period = chatHistoryPeriod({
      now,
      timeZone,
      updatedAt: item.updatedAt,
    });
    const group = byPeriod.get(period);
    if (group === undefined) {
      byPeriod.set(period, [item]);
      continue;
    }
    group.push(item);
  }
  return PERIOD_ORDER.flatMap((period) => {
    const group = byPeriod.get(period);
    return group === undefined ? [] : [{ period, items: group }];
  });
};

const MATTER_UNAVAILABLE_STATUS = 404;

/**
 * Whether the list refused the matter filter itself: the API answers 404 for
 * a matter the reader cannot open or one being deleted. Retrying cannot
 * change that, so the page offers to drop the filter instead.
 */
export const isMatterUnavailable = ({
  error,
  matter,
}: {
  error: unknown;
  matter: string | undefined;
}): boolean =>
  matter !== undefined &&
  APIError.is(error) &&
  error.status === MATTER_UNAVAILABLE_STATUS;

/** Whether the page shows a filtered view rather than the whole history. */
export const hasChatHistoryFilter = ({ matter, q }: ChatHistorySearch) =>
  matter !== undefined || (q?.trim() ?? "").length > 0;

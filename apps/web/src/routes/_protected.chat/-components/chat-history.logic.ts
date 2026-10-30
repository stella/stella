import * as v from "valibot";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { isUuid } from "@stll/api-contract/safe-id";
import { Temporal, todayFor } from "@stll/time";

import { APIError } from "@/lib/errors/api";
import { routeSearchSchema } from "@/route-search-params";

/**
 * The history page's filters live in the URL, so a reader who opens a chat
 * and comes back lands on the same search and matter. A malformed value falls
 * back to no filter instead of failing the route; the matter must be an id in
 * the format the API accepts, so a mistyped URL never reaches it.
 */
export const chatHistorySearchSchema = routeSearchSchema({
  // Longer than the API accepts would only fail; dropped like a bad matter.
  q: v.fallback(
    v.optional(v.pipe(v.string(), v.maxLength(SEARCH_QUERY_MAX_LENGTH))),
    undefined,
  ),
  matter: v.fallback(
    v.optional(v.pipe(v.string(), v.check(isUuid))),
    undefined,
  ),
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

/** The query the field last sent to the URL, until the URL shows it. */
type PendingSearchQuery =
  { status: "idle" } | { status: "sent"; query: string | undefined };

/**
 * The search field's own state: what it shows, what it knows of the URL, and
 * how many queries have reached the URL from elsewhere. A write scheduled
 * before the latest of those is stale.
 */
export type SearchFieldState = {
  externalChanges: number;
  lastUrlQuery: string | undefined;
  pending: PendingSearchQuery;
  value: string;
};

export const initialSearchFieldState = (
  urlQuery: string | undefined,
): SearchFieldState => ({
  externalChanges: 0,
  lastUrlQuery: urlQuery,
  pending: { status: "idle" },
  value: urlQuery ?? "",
});

/**
 * Keeps the field in step with the URL. A query that arrives from elsewhere
 * (Back, Forward, a link) replaces what the field shows. The field's own
 * debounced write is recognised when it lands and leaves the field alone,
 * since the reader may have typed on since it was sent. Returns the same
 * state object when nothing changed.
 */
export const syncSearchField = ({
  state,
  urlQuery,
}: {
  state: SearchFieldState;
  urlQuery: string | undefined;
}): SearchFieldState => {
  if (urlQuery === state.lastUrlQuery) {
    return state;
  }
  const ownWrite =
    state.pending.status === "sent" && state.pending.query === urlQuery;
  if (ownWrite) {
    return {
      externalChanges: state.externalChanges,
      lastUrlQuery: urlQuery,
      pending: { status: "idle" },
      value: state.value,
    };
  }
  return {
    externalChanges: state.externalChanges + 1,
    lastUrlQuery: urlQuery,
    pending: { status: "idle" },
    value: urlQuery ?? "",
  };
};

/**
 * Whether a debounced write from the field has gone stale: a query reached
 * the URL from elsewhere after the write was scheduled, so sending it would
 * overwrite that navigation with older typing. The field's own writes landing
 * do not count, so typing on while one lands is never lost.
 */
export const isStaleSearchWrite = ({
  scheduledAfter,
  state,
}: {
  /** `externalChanges` when the write was scheduled. */
  scheduledAfter: number;
  state: SearchFieldState;
}): boolean => scheduledAfter !== state.externalChanges;

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

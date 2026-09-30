import { Result } from "better-result";
import type { Static } from "elysia";

import { parsePlainDate, Temporal } from "@stll/time";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  decodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

import type { wipQuerySchema } from "./config";
import { WIP_LIMITS } from "./config";

type WipQuery = Static<typeof wipQuerySchema>;
export const readWipInput = (
  query: WipQuery,
  grouping: "matter" | "client",
) => {
  const parts = query.cursor ? decodePaginationCursor(query.cursor) : null;
  const asOf =
    query.asOf ??
    (isDateOnlyPaginationCursorPart(parts?.at(1))
      ? parts?.at(1)
      : Temporal.Now.plainDateISO("UTC").toString());
  if (typeof asOf !== "string" || parsePlainDate(asOf) === null) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_wip_date",
        message: "Invalid WIP aging date",
        hint: "Call billing.wip.list with asOf in YYYY-MM-DD format.",
      }),
    );
  }
  const scope = [
    grouping,
    asOf,
    query.matterId ?? null,
    query.clientId ?? null,
    query.currency ?? null,
  ];
  const key = parts?.at(5);
  if (
    query.cursor &&
    (!parts ||
      parts.length !== 6 ||
      scope.some((value, index) => parts.at(index) !== value) ||
      (grouping === "matter"
        ? !isUuidPaginationCursorPart(key)
        : key !== "" && !isUuidPaginationCursorPart(key)))
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_wip_cursor",
        message: "Invalid WIP cursor or changed query scope",
        hint: `Restart billing.wip.${grouping === "matter" ? "list" : "clients.list"} without a cursor; preserve the returned asOf and filters for subsequent pages.`,
      }),
    );
  }
  return Result.ok({
    asOf,
    limit: query.limit ?? WIP_LIMITS.pageDefault,
    scope,
    matterAfter:
      grouping === "matter" && isUuidPaginationCursorPart(key)
        ? brandPersistedWorkspaceId(key)
        : undefined,
    clientAfter:
      grouping === "client" && typeof key === "string" ? key : undefined,
  });
};

export const toWipCurrency = (row: {
  currency: string;
  timeAmount: string;
  expenseAmount: string;
  totalAmount: string;
  days0To30: string;
  days31To60: string;
  days61To90: string;
  daysOver90: string;
  unpricedTimeEntryCount: string;
}) => ({
  currency: row.currency,
  timeAmount: row.timeAmount,
  expenseAmount: row.expenseAmount,
  totalAmount: row.totalAmount,
  aged: {
    days0To30: row.days0To30,
    days31To60: row.days31To60,
    days61To90: row.days61To90,
    daysOver90: row.daysOver90,
  },
  unpricedTimeEntryCount: row.unpricedTimeEntryCount,
});

export const tooManyWipCurrencies = () =>
  new HandlerError({
    status: 400,
    code: "wip_currency_limit",
    message: "Too many distinct WIP currencies",
    hint: "Call billing.wip.list or billing.wip.clients.list with a currency filter to narrow the summary.",
  });

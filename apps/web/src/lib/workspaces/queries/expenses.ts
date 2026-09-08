import { queryOptions } from "@tanstack/react-query";

import type { ExpenseCategory, TimeEntryStatus } from "@stll/api-contract";
import { Temporal } from "@stll/time";

import { startOfWeek } from "@/i18n/week";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { expensesQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";

type ExpenseStatus = TimeEntryStatus;

type ExpensesFilters = {
  userId?: string;
  matterId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: ExpenseStatus;
  category?: ExpenseCategory;
  billable?: boolean;
};

type ExpensesListKey = {
  userId?: string | undefined;
  matterId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  status?: ExpenseStatus | undefined;
  category?: ExpenseCategory | undefined;
  billable?: boolean | undefined;
};

export const expensesKeys = {
  all: expensesQueryRoot,
  list: (workspaceId: string, key: ExpensesListKey) => [
    ...expensesKeys.all(workspaceId),
    {
      userId: key.userId,
      matterId: key.matterId,
      dateFrom: key.dateFrom,
      dateTo: key.dateTo,
      status: key.status,
      category: key.category,
      billable: key.billable,
    },
  ],
};

export const expensesOptions = (
  workspaceId: string,
  filters: ExpensesFilters = {},
) =>
  queryOptions({
    queryKey: expensesKeys.list(workspaceId, filters),
    queryFn: async ({ signal }) => {
      const { matterId, userId, ...restFilters } = filters;
      const response = await api
        .expenses({
          workspaceId: toSafeId<"workspace">(workspaceId),
        })
        .get({
          query: {
            ...restFilters,
            ...(userId !== undefined && { userId: toSafeId<"user">(userId) }),
            ...(matterId !== undefined && {
              matterId: toSafeId<"entity">(matterId),
            }),
          },
          fetch: { signal },
        });

      return unwrapEden(response).items;
    },
  });

export type ExpensesWeekRange = {
  monday: Temporal.PlainDate;
  sunday: Temporal.PlainDate;
  dateFrom: string;
  dateTo: string;
};

/**
 * Monday-Sunday week containing `referenceDate`, per the locale's first
 * weekday. Shared by the expenses route's `loader` (which prefetches
 * `expensesOptions` for the current week) and the page component's date
 * range state, so both derive an identical `expensesOptions` cache key on a
 * cold navigation instead of the component's mount-time fetch racing an
 * unprimed cache. The loader and component derive their reference day from
 * the same local calendar clock unless a midnight boundary falls between the
 * two calls, in which case the component's key simply differs and refetches
 * once.
 */
export const getExpensesWeekRange = (
  referenceDate: Date | Temporal.PlainDate,
  locale: string,
): ExpensesWeekRange => {
  const monday = startOfWeek(referenceDate, locale);
  const sunday = monday.add({ days: 6 });
  return {
    monday,
    sunday,
    dateFrom: monday.toString(),
    dateTo: sunday.toString(),
  };
};

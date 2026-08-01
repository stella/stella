import { queryOptions } from "@tanstack/react-query";

import { startOfWeek } from "@/i18n/week";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

type ExpenseCategory =
  | "filing_fee"
  | "expert_witness"
  | "travel"
  | "printing"
  | "courier"
  | "other";

type ExpenseStatus = "draft" | "approved" | "billed" | "written_off";

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
  all: (workspaceId: string) => ["expenses", workspaceId],
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

/** Format a Date as `YYYY-MM-DD` in local time (not UTC). */
const formatDateISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const addDays = (d: Date, n: number): Date => {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
};

export type ExpensesWeekRange = {
  monday: Date;
  sunday: Date;
  dateFrom: string;
  dateTo: string;
};

/**
 * Monday-Sunday week containing `referenceDate`, per the locale's first
 * weekday. Shared by the expenses route's `loader` (which prefetches
 * `expensesOptions` for the current week) and the page component's date
 * range state, so both derive an identical `expensesOptions` cache key on a
 * cold navigation instead of the component's mount-time fetch racing an
 * unprimed cache. The loader's `new Date()` and the component's
 * `useState(() => new Date())` resolve to the same calendar day unless a
 * midnight boundary falls between the two calls, in which case the
 * component's key simply differs and refetches once.
 */
export const getExpensesWeekRange = (
  referenceDate: Date,
  locale: string,
): ExpensesWeekRange => {
  const monday = startOfWeek(referenceDate, locale);
  const sunday = addDays(monday, 6);
  return {
    monday,
    sunday,
    dateFrom: formatDateISO(monday),
    dateTo: formatDateISO(sunday),
  };
};

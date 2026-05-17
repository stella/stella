import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.items;
    },
  });

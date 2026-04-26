import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { expensesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/expenses";

type ExpenseCategory =
  | "filing_fee"
  | "expert_witness"
  | "travel"
  | "printing"
  | "courier"
  | "other";

type CreateExpenseVars = {
  workspaceId: string;
  matterId: string;
  dateIncurred: string;
  timezoneId: string;
  amount: number;
  currency: string;
  category: ExpenseCategory;
  description: string;
  invoiceDescription?: string | null;
  billable?: boolean;
  markup?: number;
};

export const useCreateExpense = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateExpenseVars) => {
      const response = await api
        .expenses({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
          queryKey: expensesKeys.all(workspaceId),
          ...body,
          matterId: toSafeId<"entity">(body.matterId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpdateExpenseVars = {
  workspaceId: string;
  id: string;
  dateIncurred?: string;
  amount?: number;
  currency?: string;
  category?: ExpenseCategory;
  description?: string;
  invoiceDescription?: string | null;
  billable?: boolean;
  markup?: number;
  matterId?: string;
  status?: "draft" | "approved";
};

export const useUpdateExpense = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateExpenseVars) => {
      const { id, matterId, ...restBody } = body;
      const response = await api
        .expenses({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          queryKey: expensesKeys.all(workspaceId),
          ...restBody,
          id: toSafeId<"expense">(id),
          ...(matterId !== undefined && {
            matterId: toSafeId<"entity">(matterId),
          }),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeleteExpenseVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteExpense = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteExpenseVars) => {
      const response = await api
        .expenses({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .delete({
          queryKey: expensesKeys.all(workspaceId),
          id: toSafeId<"expense">(id),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

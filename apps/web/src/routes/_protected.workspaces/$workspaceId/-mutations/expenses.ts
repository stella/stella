import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
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
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: CreateExpenseVars) => {
      const response = await api.expenses({ workspaceId }).put({
        queryKey: expensesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
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
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateExpenseVars) => {
      const response = await api.expenses({ workspaceId }).patch({
        queryKey: expensesKeys.all(workspaceId),
        ...body,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type DeleteExpenseVars = {
  workspaceId: string;
  id: string;
};

export const useDeleteExpense = () => {
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ workspaceId, id }: DeleteExpenseVars) => {
      const response = await api.expenses({ workspaceId }).delete({
        queryKey: expensesKeys.all(workspaceId),
        id,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

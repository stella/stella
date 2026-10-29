import { useMutation } from "@tanstack/react-query";

import type { ExpenseCategory } from "@stll/api-contract";

import { getTranslator } from "@/i18n/translator";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { NonEmptyPatch } from "@/lib/mutation-command";
import { toSafeId } from "@/lib/safe-id";

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
          ...body,
          matterId: toSafeId<"entity">(body.matterId),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useCreateExpense:failure",
        scope: { type: "handler", handlerId: "useCreateExpense:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

type UpdateExpenseVars = {
  workspaceId: string;
  id: string;
} & NonEmptyPatch<{
  dateIncurred: string;
  amount: number;
  currency: string;
  category: ExpenseCategory;
  description: string;
  invoiceDescription: string | null;
  billable: boolean;
  markup: number;
  matterId: string;
  status: "draft" | "approved";
}>;

export const useUpdateExpense = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateExpenseVars) => {
      const { id, matterId, ...restBody } = body;
      const response = await api
        .expenses({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          ...restBody,
          id: toSafeId<"expense">(id),
          ...(matterId !== undefined && {
            matterId: toSafeId<"entity">(matterId),
          }),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useUpdateExpense:failure",
        scope: { type: "handler", handlerId: "useUpdateExpense:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
          id: toSafeId<"expense">(id),
        });

      return unwrapApiResponse(response);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useDeleteExpense:failure",
        scope: { type: "handler", handlerId: "useDeleteExpense:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

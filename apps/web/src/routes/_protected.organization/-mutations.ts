import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { organizationKeys } from "@/routes/_protected.organization/-queries";

export const useRemoveMember = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const t = useTranslations();

  return useMutation({
    mutationFn: async (memberIdOrEmail: string) => {
      const result = await authClient.organization.removeMember({
        memberIdOrEmail,
      });

      if (result.error) {
        stellaToast.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: () => {
      stellaToast.add({
        title: t("success.memberRemoved"),
        type: "success",
      });
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type InviteMemberVars = {
  email: string;
  role: Role;
  resend?: boolean;
};

export const useInviteMember = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ email, role, resend }: InviteMemberVars) => {
      const result = await authClient.organization.inviteMember({
        email,
        role,
        resend,
      });

      if (result.error) {
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: () => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

export const useCancelInvitation = () => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await authClient.organization.cancelInvitation({
        invitationId,
      });

      if (result.error) {
        stellaToast.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: () => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      stellaToast.add({
        title: t("success.invitationCanceled"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

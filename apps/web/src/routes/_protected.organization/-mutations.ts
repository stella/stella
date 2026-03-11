import { usePostHog } from "@posthog/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { toastManager } from "@stella/ui/components/toast";

import { authClient } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { organizationKeys } from "@/routes/_protected.organization/-queries";

export const useRemoveMember = () => {
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const t = useTranslations();

  return useMutation({
    mutationFn: async (memberIdOrEmail: string) => {
      const result = await authClient.organization.removeMember({
        memberIdOrEmail,
      });

      if (result.error) {
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: () => {
      toastManager.add({
        title: t("success.memberRemoved"),
        type: "success",
      });
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

type InviteMemberVars = {
  email: string;
  role: Role;
  resend?: boolean;
};

export const useInviteMember = () => {
  const t = useTranslations();
  const posthog = usePostHog();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ email, role, resend }: InviteMemberVars) => {
      const result = await authClient.organization.inviteMember({
        email,
        role,
        resend,
      });

      if (result.error) {
        toastManager.add({
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
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

export const useCancelInvitation = () => {
  const t = useTranslations();
  const posthog = usePostHog();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await authClient.organization.cancelInvitation({
        invitationId,
      });

      if (result.error) {
        toastManager.add({
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
      toastManager.add({
        title: t("success.invitationCanceled"),
        type: "success",
      });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });
};

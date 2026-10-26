import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import type { Role } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { organizationKeys } from "@/lib/organization/queries";

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
        notifyUserError(
          toAuthClientError(result.error),
          t("errors.actionFailed"),
        );
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: async () => {
      stellaToast.add({
        title: t("success.memberRemoved"),
        type: "success",
      });
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useRemoveMember:failure",
        scope: { type: "handler", handlerId: "useRemoveMember:failure" },
      });
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useInviteMember:failure",
        scope: { type: "handler", handlerId: "useInviteMember:failure" },
      });
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
        notifyUserError(
          toAuthClientError(result.error),
          t("errors.actionFailed"),
        );
        throw toAuthClientError(result.error);
      }

      return result.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      stellaToast.add({
        title: t("success.invitationCanceled"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useCancelInvitation:failure",
        scope: { type: "handler", handlerId: "useCancelInvitation:failure" },
      });
    },
  });
};

export const useUpdateMemberRole = (memberId: string) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (role: Role) => {
      const result = await authClient.organization.updateMemberRole({
        memberId,
        role,
      });

      if (result.error) {
        analytics.captureError(toAuthClientError(result.error), {
          fingerprintKey: "useUpdateMemberRole.mutationFn:failure",
          scope: {
            type: "handler",
            handlerId: "useUpdateMemberRole.mutationFn:failure",
          },
        });
        notifyUserError(
          toAuthClientError(result.error),
          t("errors.actionFailed"),
        );
        throw toAuthClientError(result.error);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      stellaToast.add({ title: t("success.roleUpdated"), type: "success" });
    },
  });
};

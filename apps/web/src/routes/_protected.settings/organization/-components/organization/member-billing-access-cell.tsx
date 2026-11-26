import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { OrganizationRoleName } from "@stll/auth-model";
import {
  BILLING_MATTER_READ_PERMISSION,
  memberHasPermissions,
} from "@stll/permissions";
import { Switch } from "@stll/ui/switch";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { resourceMutation } from "@/lib/workspace-realtime";

type MemberBillingAccessCellProps = {
  memberId: string;
  role: OrganizationRoleName;
  billingAccess: boolean;
  /** Whether the organization has time billing; the setting exists only then. */
  timeBilling: boolean;
};

export const MemberBillingAccessCell = ({
  memberId,
  role,
  billingAccess,
  timeBilling,
}: MemberBillingAccessCellProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const canManage = usePermissions({ member: ["update"] });
  const roleGrant = memberHasPermissions({
    role,
    billingAccess: false,
    permissions: BILLING_MATTER_READ_PERMISSION,
  });
  const mutation = useMutation({
    mutationFn: resourceMutation({
      mutation: "updateMemberBillingAccess",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (next: boolean) =>
        await invokeCapability(
          "organization-settings.members.billing-access.update",
          async (request) =>
            unwrapApiResponse(
              await api["organization-settings"]
                .members({ memberId })
                .billing.put({ billingAccess: next }, request),
            ),
        ),
    }),
    onError: (error) => notifyUserError(error, t("errors.actionFailed")),
  });

  if (!timeBilling) {
    return null;
  }

  if (roleGrant) {
    return (
      <span className="text-muted-foreground text-xs">
        {t("organization.members.billingAccessIncludedInRole")}
      </span>
    );
  }

  return (
    <Switch
      aria-label={t("organization.members.billingAccess")}
      checked={billingAccess}
      disabled={!canManage || mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
      size="sm"
    />
  );
};

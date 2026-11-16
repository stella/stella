import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type { OrganizationRoleName } from "@stll/auth-model";
import {
  BILLING_MATTER_READ_PERMISSION,
  memberHasPermissions,
} from "@stll/permissions";
import { Checkbox } from "@stll/ui/checkbox";

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
};
export const MemberBillingAccessCell = ({
  memberId,
  role,
  billingAccess,
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
  return (
    <Checkbox
      aria-label={t("organization.members.billingAccess")}
      checked={roleGrant || billingAccess}
      disabled={!canManage || roleGrant || mutation.isPending}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  );
};

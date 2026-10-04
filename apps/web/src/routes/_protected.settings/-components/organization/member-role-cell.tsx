import { useState } from "react";

import { useTranslations } from "use-intl";

import { assignableRoles } from "@stll/permissions";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import type { Role } from "@/lib/auth-client";
import { roleTranslationKeys } from "@/lib/organization/consts";
import { useUpdateMemberRole } from "@/lib/organization/mutations";
import { roleAssignmentOptions } from "@/lib/organization/role-assignment.logic";

type RoleCellProps = {
  memberId: string;
  memberEmail: string;
  memberRole: Role;
  currentUserRole: Role;
  isSelf: boolean;
};

export const RoleCell = ({
  memberId,
  memberEmail,
  memberRole,
  currentUserRole,
  isSelf,
}: RoleCellProps) => {
  const t = useTranslations();
  const [pendingRole, setPendingRole] = useState<Role | null>(null);

  const offeredRoles = assignableRoles(currentUserRole);
  const editable = !isSelf && offeredRoles.includes(memberRole);

  const updateRole = useUpdateMemberRole(memberId);

  if (!editable) {
    return (
      <span className="text-foreground">
        {t(`organization.roles.${memberRole}`)}
      </span>
    );
  }

  const roleData = roleAssignmentOptions(currentUserRole).map(({ value }) => ({
    description: t(roleTranslationKeys[value].descriptionKey),
    label: t(roleTranslationKeys[value].labelKey),
    value,
  }));

  const handleConfirm = async () => {
    if (pendingRole) {
      await updateRole.mutateAsync(pendingRole);
      setPendingRole(null);
    }
  };

  return (
    <>
      <Select
        disabled={updateRole.isPending}
        onValueChange={(value) => {
          if (value && offeredRoles.includes(value) && value !== memberRole) {
            setPendingRole(value);
          }
        }}
        value={memberRole}
      >
        <SelectTrigger className="min-w-32" size="sm">
          <SelectValue>{t(`organization.roles.${memberRole}`)}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} className="min-w-72">
          {roleData.map((item) => (
            <SelectItem key={item.value} label={item.label} value={item.value}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <span>{item.label}</span>
                <span className="text-muted-foreground text-xs leading-tight">
                  {item.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmation={memberEmail}
        confirmLabel={t("organization.members.changeRole")}
        description={t("organization.members.confirmRoleChangeDescription", {
          email: memberEmail,
          oldRole: t(`organization.roles.${memberRole}`),
          newRole: pendingRole ? t(`organization.roles.${pendingRole}`) : "",
        })}
        inputLabel={t("organization.members.typeEmailToConfirm", {
          email: memberEmail,
        })}
        loading={updateRole.isPending}
        onConfirm={handleConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRole(null);
          }
        }}
        open={pendingRole !== null}
        title={t("organization.members.confirmRoleChangeTitle")}
      />
    </>
  );
};

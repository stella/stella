import { useMemo, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Frame } from "@stll/ui/components/frame";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { toastManager } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, EllipsisVerticalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { roleOptions } from "@/routes/-queries";
import {
  getRoles,
  rolePriority,
} from "@/routes/_protected.organization/-consts";
import {
  useCancelInvitation,
  useInviteMember,
  useRemoveMember,
} from "@/routes/_protected.organization/-mutations";
import {
  organizationKeys,
  organizationOptions,
} from "@/routes/_protected.organization/-queries";
import { formatDate } from "@/routes/_protected.organization/-utils";
import { OrganizationListToolbar } from "@/routes/_protected.settings/-components/organization/list-toolbar";
import { OrganizationProfileCard } from "@/routes/_protected.settings/-components/organization/profile-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

const ASSIGNABLE_ROLES = ["owner", "admin", "member"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const isAssignableRole = (role: Role): role is AssignableRole =>
  (ASSIGNABLE_ROLES as readonly Role[]).includes(role);

type SortKey = "name" | "role" | "joined";
type SortDir = "asc" | "desc";
type Sort = { key: SortKey; dir: SortDir };

export const Route = createFileRoute(
  "/_protected/settings/organization/members",
)({
  component: Members,
});

function Members() {
  const t = useTranslations();
  const { data } = useSuspenseQuery(organizationOptions);
  const { data: currentUserRole } = useSuspenseQuery(roleOptions);
  const userId = Route.useRouteContext({
    select: (ctx) => ctx.user.id,
  });
  const q = useSearch({
    from: "/_protected/settings/organization",
    select: (s) => s.q,
  });

  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  const filteredMembers = useMemo(() => {
    const filtered = q
      ? data.members.filter(
          (m) =>
            m.user.name.toLowerCase().includes(q.toLowerCase()) ||
            m.user.email.toLowerCase().includes(q.toLowerCase()),
        )
      : data.members;

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sort.key === "name") {
        cmp = a.user.name.localeCompare(b.user.name);
      } else if (sort.key === "role") {
        cmp = rolePriority[a.role] - rolePriority[b.role];
      } else {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [data.members, q, sort]);

  const filteredInvitations = useMemo(() => {
    if (!q) {
      return data.invitations;
    }
    const query = q.toLowerCase();
    return data.invitations.filter((inv) =>
      inv.email.toLowerCase().includes(query),
    );
  }, [data.invitations, q]);

  const removeMember = useRemoveMember();
  const cancelInvitation = useCancelInvitation();
  const inviteMember = useInviteMember();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.membersDescription")}
        title={t("navigation.members")}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.profile")}
        </h2>
        <OrganizationProfileCard />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.activeMembers")}
        </h2>
        <Frame>
          <OrganizationListToolbar />
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead
                  active={sort.key === "name" ? sort.dir : null}
                  label={t("common.user")}
                  onClick={() => toggleSort("name")}
                />
                <SortableHead
                  active={sort.key === "role" ? sort.dir : null}
                  label={t("common.role")}
                  onClick={() => toggleSort("role")}
                />
                <SortableHead
                  active={sort.key === "joined" ? sort.dir : null}
                  label={t("organization.members.joined")}
                  onClick={() => toggleSort("joined")}
                />
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMembers.map((member) => {
                const isSelf = member.userId === userId;
                return (
                  <TableRow className="group" key={member.id}>
                    <TableCell>
                      <UserIdentity
                        avatarClassName="size-8 shrink-0 text-[0.625rem]"
                        image={member.user.image}
                        name={member.user.name}
                        secondaryText={member.user.email}
                      />
                    </TableCell>
                    <TableCell>
                      <RoleCell
                        currentUserRole={currentUserRole}
                        isSelf={isSelf}
                        memberEmail={member.user.email}
                        memberId={member.id}
                        memberRole={member.role}
                      />
                    </TableCell>
                    <TableCell>{formatDate(member.createdAt)}</TableCell>
                    <TableCell className="text-end">
                      {!isSelf && (
                        <Menu>
                          <Tooltip
                            content={t("common.actions")}
                            render={
                              <MenuTrigger
                                className="opacity-0! transition-opacity group-hover:opacity-100!"
                                render={
                                  <Button size="icon-xs" variant="ghost" />
                                }
                              />
                            }
                          >
                            <EllipsisVerticalIcon />
                          </Tooltip>
                          <MenuPopup>
                            <MenuItem
                              disabled={removeMember.isPending}
                              onClick={() => removeMember.mutate(member.id)}
                              variant="destructive"
                            >
                              {t("organization.members.removeMember")}
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredMembers.length === 0 && (
                <TableRow>
                  <TableCell
                    className="text-muted-foreground text-center"
                    colSpan={4}
                  >
                    {t("organization.members.noMembersFound")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Frame>
      </section>

      {data.invitations.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
            {t("settings.organization.pendingInvitations")}
          </h2>
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.email")}</TableHead>
                  <TableHead>{t("common.role")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("organization.invitations.invited")}</TableHead>
                  <TableHead>{t("organization.invitations.expires")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInvitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>{invitation.email}</TableCell>
                    <TableCell>
                      {t(`organization.roles.${invitation.role}`)}
                    </TableCell>
                    <TableCell>
                      {t(
                        `organization.invitations.statuses.${invitation.status}`,
                      )}
                    </TableCell>
                    <TableCell>{formatDate(invitation.createdAt)}</TableCell>
                    <TableCell>{formatDate(invitation.expiresAt)}</TableCell>
                    <TableCell className="text-end">
                      <Menu>
                        <Tooltip
                          content={t("common.actions")}
                          render={
                            <MenuTrigger
                              render={<Button size="icon-xs" variant="ghost" />}
                            />
                          }
                        >
                          <EllipsisVerticalIcon />
                        </Tooltip>
                        <MenuPopup>
                          <MenuItem
                            disabled={
                              invitation.status !== "rejected" ||
                              inviteMember.isPending
                            }
                            onClick={() => {
                              inviteMember.mutate(
                                {
                                  email: invitation.email,
                                  role: invitation.role,
                                  resend: true,
                                },
                                {
                                  onSuccess: () => {
                                    toastManager.add({
                                      title: t("success.invitationResent"),
                                      type: "success",
                                    });
                                  },
                                  onError: () => {
                                    toastManager.add({
                                      title: t("errors.actionFailed"),
                                      type: "error",
                                    });
                                  },
                                },
                              );
                            }}
                          >
                            {t("organization.invitations.resendInvitation")}
                          </MenuItem>
                          <MenuItem
                            disabled={
                              invitation.status !== "pending" ||
                              cancelInvitation.isPending
                            }
                            onClick={() =>
                              cancelInvitation.mutate(invitation.id)
                            }
                            variant="destructive"
                          >
                            {t("organization.invitations.cancelInvitation")}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredInvitations.length === 0 && (
                  <TableRow>
                    <TableCell
                      className="text-muted-foreground text-center"
                      colSpan={6}
                    >
                      {t("organization.invitations.noInvitationsFound")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Frame>
        </section>
      )}
    </>
  );
}

type RoleCellProps = {
  memberId: string;
  memberEmail: string;
  memberRole: Role;
  currentUserRole: Role;
  isSelf: boolean;
};

const RoleCell = ({
  memberId,
  memberEmail,
  memberRole,
  currentUserRole,
  isSelf,
}: RoleCellProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [pendingRole, setPendingRole] = useState<AssignableRole | null>(null);

  const outranks = rolePriority[memberRole] < rolePriority[currentUserRole];
  // editable gates the SOURCE side: the current user can edit
  // anyone they don't outrank (and not themselves). The dropdown
  // lists only the TARGET roles in ASSIGNABLE_ROLES, so an admin
  // can promote an intern/external to member/admin/owner even
  // though those source roles aren't in the picklist.
  const editable = !isSelf && !outranks;

  const updateRole = useMutation({
    mutationFn: async (role: AssignableRole) => {
      const result = await authClient.organization.updateMemberRole({
        memberId,
        role,
      });

      if (result.error) {
        analytics.captureError(toAuthClientError(result.error));
        toastManager.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      toastManager.add({ title: t("success.roleUpdated"), type: "success" });
    },
  });

  if (!editable) {
    return (
      <span className="text-foreground">
        {t(`organization.roles.${memberRole}`)}
      </span>
    );
  }

  const roleData = getRoles(t);

  return (
    <>
      <Select
        disabled={updateRole.isPending}
        onValueChange={(value) => {
          if (value && isAssignableRole(value) && value !== memberRole) {
            setPendingRole(value);
          }
        }}
        value={memberRole}
      >
        <SelectTrigger
          className={cn(
            "min-w-32 border-transparent shadow-none",
            "hover:border-input data-popup-open:border-input",
          )}
          size="sm"
        >
          <SelectValue>{t(`organization.roles.${memberRole}`)}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} className="min-w-72">
          {ASSIGNABLE_ROLES.map((role) => {
            const item = roleData.find((r) => r.value === role);
            if (!item) {
              return null;
            }
            return (
              <SelectItem key={role} label={item.label} value={role}>
                <div className="flex flex-col gap-0.5 py-0.5">
                  <span>{item.label}</span>
                  <span className="text-muted-foreground text-xs leading-tight">
                    {item.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
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
        onConfirm={async () => {
          if (pendingRole) {
            await updateRole.mutateAsync(pendingRole);
            setPendingRole(null);
          }
        }}
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

type SortableHeadProps = {
  label: string;
  active: SortDir | null;
  onClick: () => void;
};

const SortableHead = ({ label, active, onClick }: SortableHeadProps) => (
  <TableHead>
    <button
      className="text-foreground hover:text-foreground/80 group inline-flex items-center gap-1 text-start"
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
      <span
        aria-hidden
        className={cn(
          "size-3 transition-opacity",
          active === null && "opacity-0 group-hover:opacity-40",
        )}
      >
        {active === "desc" ? (
          <ArrowDownIcon className="size-3" />
        ) : (
          <ArrowUpIcon className="size-3" />
        )}
      </span>
    </button>
  </TableHead>
);

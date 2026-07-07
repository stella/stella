import { useState } from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisVerticalIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
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
import { Skeleton } from "@stll/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import type { Role } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { ensureRouteQueryData } from "@/lib/react-query";
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
import { OrganizationJurisdictionsCard } from "@/routes/_protected.settings/-components/organization/jurisdictions-card";
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

const MEMBERS_SKELETON_ROW_COUNT = 8;
const INVITATIONS_SKELETON_ROW_COUNT = 3;

// Stable keys so loading rows never fall back to array-index keys.
const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

// The members and invitations tables are hand-rolled @stll/ui markup (no
// TanStack), so a single column descriptor array per table is the source of
// truth: both the real header and the loading skeleton map over it, so they
// cannot drift. `sortKey` distinguishes sortable heads from inert ones (the
// trailing actions column has no header). `skeleton` shapes the placeholder.
type MemberSkeletonShape = "identity" | "control" | "text" | "none";

type MemberColumn = {
  id: "user" | "role" | "joined" | "actions";
  sortKey: SortKey | null;
  label: "common.user" | "common.role" | "organization.members.joined" | null;
  skeleton: MemberSkeletonShape;
};

const MEMBER_COLUMNS: readonly MemberColumn[] = [
  { id: "user", sortKey: "name", label: "common.user", skeleton: "identity" },
  { id: "role", sortKey: "role", label: "common.role", skeleton: "control" },
  {
    id: "joined",
    sortKey: "joined",
    label: "organization.members.joined",
    skeleton: "text",
  },
  { id: "actions", sortKey: null, label: null, skeleton: "none" },
];

type InvitationColumn = {
  id: "email" | "role" | "status" | "invited" | "expires" | "actions";
  label:
    | "common.email"
    | "common.role"
    | "common.status"
    | "organization.invitations.invited"
    | "organization.invitations.expires"
    | null;
};

const INVITATION_COLUMNS: readonly InvitationColumn[] = [
  { id: "email", label: "common.email" },
  { id: "role", label: "common.role" },
  { id: "status", label: "common.status" },
  { id: "invited", label: "organization.invitations.invited" },
  { id: "expires", label: "organization.invitations.expires" },
  { id: "actions", label: null },
];

export const Route = createFileRoute(
  "/_protected/settings/organization/members",
)({
  component: Members,
  pendingComponent: MembersPendingComponent,
  loader: async ({ context }) => {
    // Prime the org + role queries the page suspends on so the fetch starts
    // during navigation instead of after the component mounts and suspends.
    await Promise.all([
      ensureRouteQueryData(
        context.queryClient,
        organizationOptions(context.user.activeOrganizationId),
      ),
      ensureRouteQueryData(context.queryClient, roleOptions),
    ]);
  },
});

function Members() {
  const t = useTranslations();
  const activeOrganizationId = Route.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data } = useSuspenseQuery(organizationOptions(activeOrganizationId));
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

  const filteredMembers = (() => {
    const filtered = q
      ? data.members.filter(
          (m) =>
            m.user.name.toLowerCase().includes(q.toLowerCase()) ||
            m.user.email.toLowerCase().includes(q.toLowerCase()),
        )
      : data.members;

    const sorted = [...filtered].sort((a, b) => {
      let cmp: number;
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
  })();

  const filteredInvitations = (() => {
    if (!q) {
      return data.invitations;
    }
    const query = q.toLowerCase();
    return data.invitations.filter((inv) =>
      inv.email.toLowerCase().includes(query),
    );
  })();

  const removeMember = useRemoveMember();
  const cancelInvitation = useCancelInvitation();
  const inviteMember = useInviteMember();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.membersDescription")}
        title={t("common.members")}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("common.profile")}
        </h2>
        <OrganizationProfileCard />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.practiceJurisdictions")}
        </h2>
        <OrganizationJurisdictionsCard />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.activeMembers")}
        </h2>
        <Frame>
          <OrganizationListToolbar />
          <Table>
            <MembersTableHeader sort={sort} toggleSort={toggleSort} />
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
                              {t("common.removeMember")}
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
              <InvitationsTableHeader />
              <TableBody>
                {filteredInvitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell>
                      <BidiText direction="ltr">{invitation.email}</BidiText>
                    </TableCell>
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
                                    stellaToast.add({
                                      title: t("success.invitationResent"),
                                      type: "success",
                                    });
                                  },
                                  onError: () => {
                                    stellaToast.add({
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
        stellaToast.add({
          title: result.error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(result.error);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
      stellaToast.add({ title: t("success.roleUpdated"), type: "success" });
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
        <SelectPopup
          alignItemWithTrigger={false}
          className="min-w-72"
          collisionAvoidance={{
            align: "shift",
            fallbackAxisSide: "end",
            side: "flip",
          }}
        >
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
      className="text-foreground hover:text-foreground-strong-muted group inline-flex items-center gap-1 text-start"
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

type MembersTableHeaderProps = {
  sort: Sort;
  toggleSort: (key: SortKey) => void;
};

// Real header and skeleton both map over MEMBER_COLUMNS, so adding, removing,
// or reordering a column updates both at once.
const MembersTableHeader = ({ sort, toggleSort }: MembersTableHeaderProps) => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        {MEMBER_COLUMNS.map((column) => {
          if (column.sortKey === null || column.label === null) {
            return <TableHead key={column.id} />;
          }
          const sortKey = column.sortKey;
          return (
            <SortableHead
              active={sort.key === sortKey ? sort.dir : null}
              key={column.id}
              label={t(column.label)}
              onClick={() => toggleSort(sortKey)}
            />
          );
        })}
      </TableRow>
    </TableHeader>
  );
};

const InvitationsTableHeader = () => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        {INVITATION_COLUMNS.map((column) =>
          column.label === null ? (
            <TableHead key={column.id} />
          ) : (
            <TableHead key={column.id}>{t(column.label)}</TableHead>
          ),
        )}
      </TableRow>
    </TableHeader>
  );
};

const MemberSkeletonCell = ({ shape }: { shape: MemberSkeletonShape }) => {
  if (shape === "identity") {
    return (
      <div className="flex items-center gap-2">
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    );
  }
  if (shape === "control") {
    return <Skeleton className="h-8 w-32" />;
  }
  if (shape === "none") {
    return null;
  }
  return <Skeleton className="h-4 w-24" />;
};

// Skeleton body derived from MEMBER_COLUMNS: one cell per column, in order, so
// it stays aligned with both the real header and the real rows.
const MembersSkeletonRows = () =>
  SKELETON_ROW_KEYS.slice(0, MEMBERS_SKELETON_ROW_COUNT).map((rowKey) => (
    <TableRow key={rowKey}>
      {MEMBER_COLUMNS.map((column) => (
        <TableCell key={column.id}>
          <MemberSkeletonCell shape={column.skeleton} />
        </TableCell>
      ))}
    </TableRow>
  ));

const InvitationsSkeletonRows = () =>
  SKELETON_ROW_KEYS.slice(0, INVITATIONS_SKELETON_ROW_COUNT).map((rowKey) => (
    <TableRow key={rowKey}>
      {INVITATION_COLUMNS.map((column) => (
        <TableCell key={column.id}>
          {column.id === "actions" ? null : <Skeleton className="h-4 w-24" />}
        </TableCell>
      ))}
    </TableRow>
  ));

// Inert toolbar matching OrganizationListToolbar's layout so the pending shell
// reserves the same space and the page does not jump when data resolves.
const MembersToolbarPlaceholder = () => {
  const t = useTranslations();

  return (
    <div className="border-border/60 flex items-center gap-2 border-b px-2 py-2">
      <InputGroup className="max-w-sm flex-1">
        <InputGroupInput disabled placeholder={t("common.search")} />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
};

const NOOP_SORT: Sort = { key: "name", dir: "asc" };
const noopToggleSort = () => undefined;

// Card placeholder for the profile/jurisdictions sections. The real cards
// (OrganizationProfileCard, OrganizationJurisdictionsCard) call their own
// suspense/queries against organizationOptions, so rendering them here would
// re-suspend the pending shell and fall back to the bare logo. A static
// skeleton keeps this component fully synchronous.
const CardSkeletonPlaceholder = () => (
  <Frame>
    <FramePanel className="flex flex-col gap-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-9 w-full max-w-sm" />
    </FramePanel>
  </Frame>
);

// Structural skeleton for route-pending: the section headers plus the members
// table chrome (headers from MEMBER_COLUMNS) with shimmer rows, and the
// invitations table chrome with a few shimmer rows. Hoisted `function` so the
// Route literal above can reference it.
function MembersPendingComponent() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.membersDescription")}
        title={t("common.members")}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("common.profile")}
        </h2>
        <CardSkeletonPlaceholder />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.practiceJurisdictions")}
        </h2>
        <CardSkeletonPlaceholder />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.activeMembers")}
        </h2>
        <Frame>
          <MembersToolbarPlaceholder />
          <Table>
            <MembersTableHeader sort={NOOP_SORT} toggleSort={noopToggleSort} />
            <TableBody>
              <MembersSkeletonRows />
            </TableBody>
          </Table>
        </Frame>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
          {t("settings.organization.pendingInvitations")}
        </h2>
        <Frame>
          <Table>
            <InvitationsTableHeader />
            <TableBody>
              <InvitationsSkeletonRows />
            </TableBody>
          </Table>
        </Frame>
      </section>
    </>
  );
}

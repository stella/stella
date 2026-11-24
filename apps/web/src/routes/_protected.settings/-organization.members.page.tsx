import { useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useSearch } from "@tanstack/react-router";
import { useNow, useTranslations } from "use-intl";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { compareByLocale } from "@stll/collation";
import { Button } from "@stll/ui/button";
import { EntityActions, EntityActionsButton } from "@stll/ui/entity-actions";
import type { EntityAction } from "@stll/ui/entity-actions";
import { CircleHelpIcon } from "@stll/ui/icons";
import { SortableHead, TableCell, TableRow } from "@stll/ui/table";
import { stellaToast } from "@stll/ui/toast";

import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { useFormatter, useFormattingLocale } from "@/i18n/formatting-context";
import { roleOptions } from "@/lib/auth-queries";
import {
  useCancelInvitation,
  useInviteMember,
  useRemoveMember,
} from "@/lib/organization/mutations";
import { organizationOptions } from "@/lib/organization/queries";
import { formatFullTimestamp, MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { MembersInvitations } from "@/routes/_protected.settings/organization/-components/members-invitations";
import { OrganizationListToolbar } from "@/routes/_protected.settings/organization/-components/organization/list-toolbar";
import { MemberBillingAccessCell } from "@/routes/_protected.settings/organization/-components/organization/member-billing-access-cell";
import { RoleCell } from "@/routes/_protected.settings/organization/-components/organization/member-role-cell";
import { filterOrganizationLists } from "@/routes/_protected.settings/organization/-components/organization/members-search.logic";

import {
  INITIAL_MEMBERS_SORT,
  MEMBER_COLUMN_COUNT,
  MemberRowCells,
  MembersShell,
} from "./-organization.members.pending";
import type { Sort, SortKey } from "./-organization.members.pending";

const routeApi = getRouteApi("/_protected/settings/organization/members");

/** /settings/organization/members: the organization's members and invitations. */
export const MembersPage = () => {
  // Re-read the clock so an invitation that expires while the page stays
  // open moves from Pending to Past invitations.
  const now = useNow({ updateInterval: 60_000 });
  const t = useTranslations();
  const formatter = useFormatter();
  const locale = useFormattingLocale();
  const activeOrganizationId = routeApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data } = useSuspenseQuery(organizationOptions(activeOrganizationId));
  const { data: currentUserRole } = useSuspenseQuery(roleOptions);
  const userId = routeApi.useRouteContext({
    select: (ctx) => ctx.user.id,
  });
  const q = useSearch({
    from: "/_protected/settings/organization",
    select: (s) => s.q,
  });

  const [sort, setSort] = useState<Sort>(INITIAL_MEMBERS_SORT);

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  const { invitations: filteredInvitations, members } = filterOrganizationLists(
    {
      invitations: data.invitations,
      members: data.members,
      query: q,
    },
  );
  const filteredMembers = (() => {
    const compareName = compareByLocale(locale);
    const sorted = members.toSorted((a, b) => {
      let cmp: number;
      if (sort.key === "name") {
        cmp = compareName(a.user.name, b.user.name);
      } else if (sort.key === "role") {
        cmp =
          ORGANIZATION_ROLE_NAMES.indexOf(a.role) -
          ORGANIZATION_ROLE_NAMES.indexOf(b.role);
      } else {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });

    return sorted;
  })();

  const removeMember = useRemoveMember();
  const cancelInvitation = useCancelInvitation();
  const inviteMember = useInviteMember();

  return (
    <MembersShell
      billingHeaderHelp={
        <Tooltip
          content={
            <span className="block max-w-64 text-wrap">
              {t("organization.members.billingAccessDescription")}
            </span>
          }
          render={
            <Button
              aria-label={t("organization.members.billingAccess")}
              size="icon-xs"
              variant="muted"
            />
          }
        >
          <CircleHelpIcon aria-hidden="true" className="size-3.5" />
        </Tooltip>
      }
      invitations={
        <MembersInvitations
          invitations={filteredInvitations}
          now={now}
          resendPending={inviteMember.isPending}
          cancelPending={cancelInvitation.isPending}
          onCancel={(invitationId) => cancelInvitation.mutate(invitationId)}
          onResend={(invitation) =>
            inviteMember.mutate(
              { email: invitation.email, role: invitation.role, resend: true },
              {
                onSuccess: () => {
                  stellaToast.add({
                    title: t("success.invitationResent"),
                    type: "success",
                  });
                },
              },
            )
          }
        />
      }
      renderSortableHead={({ className, label, sortKey }) => (
        <SortableHead
          className={className}
          key={sortKey}
          onSort={() => toggleSort(sortKey)}
          sortDirection={sort.key === sortKey ? sort.dir : null}
        >
          {label}
        </SortableHead>
      )}
      toolbar={<OrganizationListToolbar />}
    >
      {filteredMembers.map((member) => {
        const isSelf = member.userId === userId;
        const rowActions: readonly EntityAction[] = isSelf
          ? []
          : [
              {
                label: t("common.removeMember"),
                variant: "destructive",
                disabled: removeMember.isPending,
                onClick: () => removeMember.mutate(member.id),
              },
            ];
        return (
          <EntityActions
            actions={rowActions}
            key={member.id}
            label={t("common.actions")}
            render={<TableRow className="group" />}
          >
            <MemberRowCells
              cells={{
                user: (
                  <UserIdentity
                    avatarClassName="size-8 shrink-0 text-3xs"
                    image={member.user.image}
                    name={member.user.name}
                    secondaryText={member.user.email}
                  />
                ),
                role: (
                  <RoleCell
                    currentUserRole={currentUserRole}
                    isSelf={isSelf}
                    memberEmail={member.user.email}
                    memberId={member.id}
                    memberRole={member.role}
                  />
                ),
                billing: (
                  <MemberBillingAccessCell
                    memberId={member.id}
                    role={member.role}
                    billingAccess={member.billingAccess}
                  />
                ),
                joined: (
                  <Tooltip
                    content={formatFullTimestamp(member.createdAt)}
                    render={<span />}
                  >
                    {formatter.dateTime(
                      new Date(member.createdAt),
                      MEDIUM_DATE_FORMAT,
                    )}
                  </Tooltip>
                ),
                actions: <EntityActionsButton />,
              }}
            />
          </EntityActions>
        );
      })}
      {filteredMembers.length === 0 && (
        <TableRow>
          <TableCell align="center" colSpan={MEMBER_COLUMN_COUNT} tone="muted">
            {t("organization.members.noMembersFound")}
          </TableCell>
        </TableRow>
      )}
    </MembersShell>
  );
};

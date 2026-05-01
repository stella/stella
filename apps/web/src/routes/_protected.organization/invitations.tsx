import { useMemo } from "react";

import { Button } from "@stll/ui/components/button";
import { Frame } from "@stll/ui/components/frame";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { toastManager } from "@stll/ui/components/toast";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { EllipsisVerticalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { OrganizationListToolbar } from "@/routes/_protected.organization/-components/organization-list-toolbar";
import {
  useCancelInvitation,
  useInviteMember,
} from "@/routes/_protected.organization/-mutations";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import { formatDate } from "@/routes/_protected.organization/-utils";

export const Route = createFileRoute("/_protected/organization/invitations")({
  component: Invitations,
});

function Invitations() {
  const t = useTranslations();
  const { data } = useSuspenseQuery(organizationOptions);
  const q = useSearch({ from: "/_protected/organization", select: (s) => s.q });

  const filtered = useMemo(() => {
    if (!q) {
      return data.invitations;
    }
    const query = q.toLowerCase();
    return data.invitations.filter((inv) =>
      inv.email.toLowerCase().includes(query),
    );
  }, [data.invitations, q]);

  const cancelInvitation = useCancelInvitation();
  const inviteMember = useInviteMember();

  return (
    <div className="flex flex-col gap-4">
      <OrganizationListToolbar />
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
            {filtered.map((invitation) => (
              <TableRow key={invitation.id}>
                <TableCell>{invitation.email}</TableCell>
                <TableCell>
                  {t(`organization.roles.${invitation.role}`)}
                </TableCell>
                <TableCell>
                  {t(`organization.invitations.statuses.${invitation.status}`)}
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
                        onClick={() => cancelInvitation.mutate(invitation.id)}
                        variant="destructive"
                      >
                        {t("organization.invitations.cancelInvitation")}
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
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
    </div>
  );
}

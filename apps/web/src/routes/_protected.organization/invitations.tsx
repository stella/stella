import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { EllipsisVerticalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Frame } from "@stella/ui/components/frame";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stella/ui/components/table";
import { toastManager } from "@stella/ui/components/toast";

import Tooltip from "@/components/tooltip";
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
  const { q } = useSearch({ from: "/_protected/organization" });

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
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("common.email")}</TableHead>
            <TableHead>{t("common.role")}</TableHead>
            <TableHead>{t("organization.invitations.status")}</TableHead>
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
              <TableCell className="text-right">
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
                className="text-center text-muted-foreground"
                colSpan={6}
              >
                {t("organization.invitations.noInvitationsFound")}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Frame>
  );
}

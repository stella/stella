import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { classifyInvitation } from "@stll/auth-model/invitation-sections";
import type { InvitationStatus } from "@stll/auth-model/invitation-sections";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { EllipsisVerticalIcon } from "@stll/ui/icons";
import { ListGroupCount } from "@stll/ui/list";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { TableCell, TableRow } from "@stll/ui/table";

import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import type { Role } from "@/lib/auth-client";
import { roleTranslationKeys } from "@/lib/organization/consts";

import {
  InvitationsTableFrame,
  InvitationsTableRow,
  PendingInvitationsSection,
} from "./members-invitations.pending";

export type MemberInvitation = {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  createdAt: Date | string;
  expiresAt: Date | string;
};

type MembersInvitationsProps = {
  invitations: MemberInvitation[];
  now: Date;
  onResend: (invitation: MemberInvitation) => void;
  onCancel: (invitationId: string) => void;
  resendPending: boolean;
  cancelPending: boolean;
};

export function MembersInvitations(props: MembersInvitationsProps) {
  const t = useTranslations();
  const formatter = useFormatter();
  const [history, setHistory] = useState<"collapsed" | "expanded">("collapsed");
  const historyId = useId();
  const pending = props.invitations.filter(
    (invitation) =>
      classifyInvitation(invitation, props.now).section === "pending",
  );
  const past = props.invitations.filter(
    (invitation) =>
      classifyInvitation(invitation, props.now).section === "past",
  );
  return (
    <>
      {pending.length > 0 && (
        <PendingInvitationsSection
          ariaLabel={t("settings.organization.pendingInvitations")}
          badge={<ListGroupCount count={formatter.number(pending.length)} />}
          title={t("settings.organization.pendingInvitations")}
        >
          <InvitationsTable {...props} invitations={pending} />
        </PendingInvitationsSection>
      )}
      {past.length > 0 && (
        <section
          aria-label={t("settings.organization.pastInvitations")}
          className="flex flex-col gap-2"
        >
          <h2>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={history === "expanded"}
              aria-controls={historyId}
              onClick={() =>
                setHistory(history === "expanded" ? "collapsed" : "expanded")
              }
            >
              {t("settings.organization.pastInvitations")}{" "}
              <ListGroupCount count={formatter.number(past.length)} />
            </Button>
          </h2>
          <div id={historyId}>
            {history === "expanded" && (
              <InvitationsTable {...props} invitations={past} />
            )}
          </div>
        </section>
      )}
    </>
  );
}

function InvitationsTable({
  invitations,
  now,
  onResend,
  onCancel,
  resendPending,
  cancelPending,
}: MembersInvitationsProps) {
  const t = useTranslations();
  const formatter = useFormatter();
  // Cancelling is final: the auth layer has no way back to the same invitation,
  // and a new one carries a new link. Hence a confirmation rather than an undo.
  const [cancelTarget, setCancelTarget] = useState<MemberInvitation | null>(
    null,
  );
  const formatMemberDate = (date: Date | string) =>
    formatter.dateTime(new Date(date), { dateStyle: "medium" });
  return (
    <InvitationsTableFrame
      label={(id) => t(id)}
      dialog={
        <AlertDialog
          onOpenChange={(open) => {
            if (!open) {
              setCancelTarget(null);
            }
          }}
          open={cancelTarget !== null}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("organization.invitations.cancelInvitation")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("organization.invitations.cancelConfirmDescription", {
                  email: cancelTarget?.email ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>
                {t("organization.invitations.keepInvitation")}
              </AlertDialogClose>
              <AlertDialogClose
                render={
                  <Button
                    onClick={() => {
                      if (cancelTarget) {
                        onCancel(cancelTarget.id);
                      }
                    }}
                    variant="destructive"
                  />
                }
              >
                {t("organization.invitations.cancelInvitation")}
              </AlertDialogClose>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      }
    >
      {invitations.map((invitation) => {
        const { section, status } = classifyInvitation(invitation, now);
        return (
          <InvitationsTableRow
            cells={{
              email: <BidiText direction="ltr">{invitation.email}</BidiText>,
              role: t(roleTranslationKeys[invitation.role].labelKey),
              status: t(`organization.invitations.statuses.${status}`),
              invited: formatMemberDate(invitation.createdAt),
              expires: formatMemberDate(invitation.expiresAt),
              actions: (
                <Menu>
                  <Tooltip
                    content={t("common.actions")}
                    render={
                      <MenuTrigger
                        render={
                          <Button
                            aria-label={t("common.actions")}
                            size="icon-xs"
                            variant="ghost"
                          />
                        }
                      />
                    }
                  >
                    <EllipsisVerticalIcon />
                  </Tooltip>
                  <MenuPopup>
                    <MenuItem
                      disabled={
                        !["expired", "rejected"].includes(status) ||
                        resendPending
                      }
                      onClick={() => onResend(invitation)}
                    >
                      {t("organization.invitations.resendInvitation")}
                    </MenuItem>
                    <MenuItem
                      disabled={section !== "pending" || cancelPending}
                      onClick={() => setCancelTarget(invitation)}
                      variant="destructive"
                    >
                      {t("organization.invitations.cancelInvitation")}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ),
            }}
            key={invitation.id}
          />
        );
      })}
      {invitations.length === 0 && (
        <TableRow>
          <TableCell className="text-muted-foreground text-center" colSpan={6}>
            {t("organization.invitations.noInvitationsFound")}
          </TableCell>
        </TableRow>
      )}
    </InvitationsTableFrame>
  );
}

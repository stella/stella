import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { classifyInvitation } from "@stll/auth-model/invitation-sections";
import type { InvitationStatus } from "@stll/auth-model/invitation-sections";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Frame } from "@stll/ui/frame";
import { EllipsisVerticalIcon } from "@stll/ui/icons";
import { ListGroupCount } from "@stll/ui/list";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import type { Role } from "@/lib/auth-client";

const SECONDARY_COLUMN_CLASS = "hidden sm:table-cell";

type InvitationColumn = {
  id: "email" | "role" | "status" | "invited" | "expires" | "actions";
  label:
    | "common.email"
    | "common.role"
    | "common.status"
    | "organization.invitations.invited"
    | "organization.invitations.expires"
    | null;
  secondary?: true;
};

export const INVITATION_COLUMNS: readonly InvitationColumn[] = [
  { id: "email", label: "common.email" },
  { id: "role", label: "common.role" },
  { id: "status", label: "common.status" },
  {
    id: "invited",
    label: "organization.invitations.invited",
    secondary: true,
  },
  {
    id: "expires",
    label: "organization.invitations.expires",
    secondary: true,
  },
  { id: "actions", label: null },
];

const isSecondaryInvitationColumn = (id: InvitationColumn["id"]) =>
  INVITATION_COLUMNS.some((column) => column.id === id && column.secondary);

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
        <section
          aria-label={t("settings.organization.pendingInvitations")}
          className="flex flex-col gap-2"
        >
          <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
            {t("settings.organization.pendingInvitations")}{" "}
            <ListGroupCount count={formatter.number(pending.length)} />
          </h2>
          <InvitationsTable {...props} invitations={pending} />
        </section>
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
  const formatMemberDate = (date: Date | string) =>
    formatter.dateTime(new Date(date), { dateStyle: "medium" });
  return (
    <Frame>
      <Table>
        <InvitationsTableHeader />
        <TableBody>
          {invitations.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell>
                <BidiText direction="ltr">{invitation.email}</BidiText>
              </TableCell>
              <TableCell>
                {t(`organization.roles.${invitation.role}`)}
              </TableCell>
              <TableCell>
                {t(
                  `organization.invitations.statuses.${classifyInvitation(invitation, now).status}`,
                )}
              </TableCell>
              <TableCell
                className={cn(
                  isSecondaryInvitationColumn("invited") &&
                    SECONDARY_COLUMN_CLASS,
                )}
              >
                {formatMemberDate(invitation.createdAt)}
              </TableCell>
              <TableCell
                className={cn(
                  isSecondaryInvitationColumn("expires") &&
                    SECONDARY_COLUMN_CLASS,
                )}
              >
                {formatMemberDate(invitation.expiresAt)}
              </TableCell>
              <TableCell className="text-end">
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
                        !["expired", "rejected"].includes(
                          classifyInvitation(invitation, now).status,
                        ) || resendPending
                      }
                      onClick={() => onResend(invitation)}
                    >
                      {t("organization.invitations.resendInvitation")}
                    </MenuItem>
                    <MenuItem
                      disabled={
                        classifyInvitation(invitation, now).section !==
                          "pending" || cancelPending
                      }
                      onClick={() => onCancel(invitation.id)}
                      variant="destructive"
                    >
                      {t("organization.invitations.cancelInvitation")}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </TableCell>
            </TableRow>
          ))}
          {invitations.length === 0 && (
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
  );
}

export const InvitationsTableHeader = () => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        {INVITATION_COLUMNS.map((column) =>
          column.label === null ? (
            <TableHead
              className={cn(column.secondary && SECONDARY_COLUMN_CLASS)}
              key={column.id}
            />
          ) : (
            <TableHead
              className={cn(column.secondary && SECONDARY_COLUMN_CLASS)}
              key={column.id}
            >
              {t(column.label)}
            </TableHead>
          ),
        )}
      </TableRow>
    </TableHeader>
  );
};

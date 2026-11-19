import type { ComponentProps } from "react";

import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { TableCell, TableHead, TableHeader, TableRow } from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

// Secondary columns give way on phones, so the columns people act on fit
// without scrolling sideways.
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

// The invitations table's columns: its header, its rows and its loading rows
// all follow this list, so they cannot drift.
const INVITATION_COLUMNS: readonly InvitationColumn[] = [
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

/** Rows held open while the invitations load. */
const INVITATIONS_SKELETON_ROW_COUNT = 3;

/** An invitation row's cell, hidden on phones when its column is secondary. */
export const InvitationTableCell = ({
  columnId,
  ...props
}: { columnId: InvitationColumn["id"] } & Omit<
  ComponentProps<typeof TableCell>,
  "className"
>) => (
  <TableCell
    {...props}
    className={cn(
      isSecondaryInvitationColumn(columnId) && SECONDARY_COLUMN_CLASS,
    )}
  />
);

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

/** Loading rows, one placeholder cell per invitation column. */
export const InvitationsSkeletonRows = () =>
  Array.from({ length: INVITATIONS_SKELETON_ROW_COUNT }, (_, row) => (
    <TableRow key={row}>
      {INVITATION_COLUMNS.map((column) => (
        <TableCell
          className={cn(column.secondary && SECONDARY_COLUMN_CLASS)}
          key={column.id}
        >
          {column.id === "actions" ? null : <Skeleton className="h-4 w-24" />}
        </TableCell>
      ))}
    </TableRow>
  ));

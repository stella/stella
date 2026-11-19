import type { ReactNode } from "react";

import { Frame } from "@stll/ui/frame";
import {
  Table,
  TableBody,
  TableCellFace,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";

import { PendingText } from "@/components/pending-text";

type InvitationColumnLabel =
  | "common.email"
  | "common.role"
  | "common.status"
  | "organization.invitations.invited"
  | "organization.invitations.expires";

type InvitationColumn = {
  id: "email" | "role" | "status" | "invited" | "expires" | "actions";
  className?: string;
} & (
  | { label: InvitationColumnLabel; bar: string }
  | { label?: undefined; placeholder: null }
);

const SECONDARY_COLUMN_CLASS = "hidden sm:table-cell";

const INVITATION_COLUMNS: readonly InvitationColumn[] = [
  { id: "email", label: "common.email", bar: "w-24" },
  { id: "role", label: "common.role", bar: "w-12" },
  { id: "status", label: "common.status", bar: "w-12" },
  {
    id: "invited",
    label: "organization.invitations.invited",
    bar: "w-20",
    className: SECONDARY_COLUMN_CLASS,
  },
  {
    id: "expires",
    label: "organization.invitations.expires",
    bar: "w-20",
    className: SECONDARY_COLUMN_CLASS,
  },
  { id: "actions", placeholder: null },
];

const INVITATIONS_SKELETON_ROW_COUNT = 3;

export const InvitationsTableRow = ({
  cells,
}: {
  cells: Record<InvitationColumn["id"], ReactNode>;
}) => (
  <TableRow>
    {INVITATION_COLUMNS.map(({ id, className }) => (
      <TableCellFace
        align={id === "actions" ? "end" : undefined}
        className={className}
        key={id}
      >
        {cells[id]}
      </TableCellFace>
    ))}
  </TableRow>
);

export const InvitationsTableFrame = ({
  label,
  children,
  dialog,
}: {
  label: (id: InvitationColumnLabel) => ReactNode;
  children: ReactNode;
  dialog?: ReactNode;
}) => (
  <Frame>
    <Table>
      <TableHeader>
        <TableRow>
          {INVITATION_COLUMNS.map((column) => (
            <TableHead className={column.className} key={column.id}>
              {column.label === undefined ? null : label(column.label)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
    {dialog}
  </Frame>
);

export const PendingInvitationsSection = ({
  title,
  badge,
  children,
  ariaLabel,
}: {
  title: ReactNode;
  badge: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}) => (
  <section aria-label={ariaLabel} className="flex flex-col gap-2">
    <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
      {title} {badge}
    </h2>
    {children}
  </section>
);

export const PendingInvitations = () => (
  <PendingInvitationsSection
    title={
      <PendingText
        id="settings.organization.pendingInvitations"
        barClassName="w-28"
      />
    }
    badge={<span aria-hidden="true" className="inline-block w-4" />}
  >
    <InvitationsTableFrame
      label={(id) => <PendingText id={id} barClassName="w-12" />}
    >
      <TableSkeletonRows
        columns={INVITATION_COLUMNS}
        count={INVITATIONS_SKELETON_ROW_COUNT}
      />
    </InvitationsTableFrame>
  </PendingInvitationsSection>
);

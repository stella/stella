import type { ReactNode } from "react";

import { Frame, FramePanel } from "@stll/ui/frame";
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

type BillingLabel = Parameters<typeof PendingText>[0]["id"];

export const BillingSettingsFrame = ({
  actions,
  children,
  controls,
  description,
  heading,
}: {
  actions: ReactNode;
  children: ReactNode;
  controls?: ReactNode;
  description: BillingLabel;
  heading?: BillingLabel;
}) => (
  <Frame>
    <FramePanel className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {heading !== undefined && (
            <h2 className="text-sm font-medium">
              <PendingText id={heading} />
            </h2>
          )}
          <p className="text-muted-foreground text-sm">
            <PendingText barClassName="w-64" id={description} />
          </p>
        </div>
        {actions}
      </div>
      {controls}
      {children}
    </FramePanel>
  </Frame>
);

export type BillingSettingsColumn = {
  id: string;
  label: BillingLabel;
  bar: string;
  className?: string;
};

type BillingSettingsRows =
  | { type: "pending"; rowClassName?: string }
  | { type: "loaded"; children: ReactNode };

export const BillingSettingsTable = ({
  columns,
  rows,
}: {
  columns: readonly BillingSettingsColumn[];
  rows: BillingSettingsRows;
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        {columns.map(({ id, label, className }) => (
          <TableHead className={className} key={id}>
            <PendingText id={label} />
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
    <TableBody aria-busy={rows.type === "pending" || undefined}>
      {rows.type === "pending" ? (
        <TableSkeletonRows columns={columns} rowClassName={rows.rowClassName} />
      ) : (
        rows.children
      )}
    </TableBody>
  </Table>
);

export const BillingSettingsRow = <ColumnId extends string>({
  columns,
  cells,
}: {
  columns: readonly (BillingSettingsColumn & { id: ColumnId })[];
  cells: Record<NoInfer<ColumnId>, ReactNode>;
}) => (
  <TableRow>
    {columns.map(({ id, className }) => (
      <TableCellFace className={className} key={id}>
        {cells[id]}
      </TableCellFace>
    ))}
  </TableRow>
);

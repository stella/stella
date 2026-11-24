import type { ComponentProps, ReactNode } from "react";

import { SettingsPanel, SettingsSection } from "@stll/ui/settings";
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
  <SettingsSection
    action={actions}
    description={<PendingText barClassName="w-64" id={description} />}
    title={heading === undefined ? undefined : <PendingText id={heading} />}
  >
    {/* The cards put status lines, refusals and the empty state beside the
        table, so the table shares the padded panel with them. */}
    <SettingsPanel>
      <div className="flex flex-col gap-4">
        {controls}
        {children}
      </div>
    </SettingsPanel>
  </SettingsSection>
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

export const BillingSettingsRowElement = (
  props: ComponentProps<typeof TableRow>,
) => <TableRow {...props} />;

export const BillingSettingsRowCells = <ColumnId extends string>({
  columns,
  cells,
}: {
  columns: readonly (BillingSettingsColumn & { id: ColumnId })[];
  cells: Record<NoInfer<ColumnId>, ReactNode>;
}) => (
  <>
    {columns.map(({ id, className }) => (
      <TableCellFace className={className} key={id}>
        {cells[id]}
      </TableCellFace>
    ))}
  </>
);

export const BillingSettingsRow = <ColumnId extends string>({
  columns,
  cells,
}: {
  columns: readonly (BillingSettingsColumn & { id: ColumnId })[];
  cells: Record<NoInfer<ColumnId>, ReactNode>;
}) => (
  <TableRow>
    <BillingSettingsRowCells cells={cells} columns={columns} />
  </TableRow>
);

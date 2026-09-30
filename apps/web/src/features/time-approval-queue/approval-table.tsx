import { useId } from "react";

import {
  createColumnHelper,
  createCoreRowModel,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useFormatter, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { TableSkeletonRows } from "@/components/table-skeleton-rows";
import type { TranslationKey } from "@/i18n/types";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import type { ApprovalEntry, ApprovalResult } from "@/lib/time-approval-queue";

import { APPROVAL_REFUSAL_KEYS } from "./approval-state";

const APPROVAL_STATUS_KEYS = {
  draft: "billing.statuses.draft",
  approved: "billing.statuses.approved",
  billed: "billing.statuses.billed",
  written_off: "billing.statuses.written_off",
} as const satisfies Record<ApprovalEntry["status"], TranslationKey>;

const APPROVAL_COLUMNS = {
  selection: "common.selectAll",
  date: "common.date",
  member: "organization.roles.member",
  matter: "common.matter",
  narrative: "billing.narrative",
  logged: "billing.approvalQueue.logged",
  billed: "billing.approvalQueue.billed",
  status: "common.status",
  actions: "common.actions",
} as const satisfies Record<string, TranslationKey>;
const approvalTableFeatures = tableFeatures({
  coreRowModel: createCoreRowModel(),
});
const columnHelper = createColumnHelper<
  typeof approvalTableFeatures,
  ApprovalEntry
>();
const approvalColumns = columnHelper.columns(
  Object.entries(APPROVAL_COLUMNS).map(([id, header]) =>
    columnHelper.display({ id, header }),
  ),
);

type ApprovalTableProps = {
  entries: ApprovalEntry[];
  results: ApprovalResult[];
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  onApprove: (ids: string[]) => void;
  onReturn: (entry: ApprovalEntry) => void;
  pending: boolean;
  loading?: boolean;
  members: ReadonlyMap<string, string>;
  matters: ReadonlyMap<string, string>;
};
export const ApprovalTable = ({
  entries,
  results,
  selectedIds,
  onSelectedIdsChange,
  onApprove,
  onReturn,
  pending,
  loading = false,
  members,
  matters,
}: ApprovalTableProps) => {
  const selectionId = useId();
  const t = useTranslations();
  const table = useTable({
    features: approvalTableFeatures,
    data: entries,
    columns: approvalColumns,
    getRowId: (entry) => entry.id,
  });
  const columns = table.getAllLeafColumns();
  const selected = new Set(selectedIds);
  const visibleIds = entries.map(({ id }) => id);
  const selectedVisibleIds = visibleIds.filter((id) => selected.has(id));
  const allSelected =
    entries.length > 0 && selectedVisibleIds.length === entries.length;
  const outcomes = new Map(results.map((result) => [result.id, result]));
  const selectVisible = (checked: boolean) => {
    const next = new Set(selectedIds);
    for (const id of visibleIds) {
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
    }
    onSelectedIdsChange([...next]);
  };

  if (!loading && entries.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-sm">
        {t("billing.approvalQueue.empty")}
      </p>
    );
  }
  return (
    <div aria-busy={loading} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          className="min-h-11"
          disabled={pending || loading || selectedVisibleIds.length === 0}
          onClick={() => onApprove(selectedVisibleIds)}
          size="sm"
          variant="outline"
        >
          {t("billing.approveSelected")}
        </Button>
        <Button
          className="min-h-11"
          disabled={pending || loading}
          onClick={() => onApprove(visibleIds)}
          size="sm"
        >
          {t("billing.approvalQueue.approveVisible")}
        </Button>
      </div>
      <Table>
        <caption className="sr-only">
          {t("billing.approvalQueue.title")}
        </caption>
        <TableHeader>
          <TableRow>
            {Object.entries(APPROVAL_COLUMNS).map(([id, label]) => (
              <TableHead key={id}>
                {id === "selection" ? (
                  <label
                    htmlFor={selectionId}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center"
                  >
                    <Checkbox
                      id={selectionId}
                      aria-label={t("common.selectAll")}
                      checked={allSelected}
                      indeterminate={
                        !allSelected && selectedVisibleIds.length > 0
                      }
                      disabled={pending || loading}
                      onCheckedChange={selectVisible}
                    />
                  </label>
                ) : (
                  t(label)
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={columns} rowCount={3} />
          ) : (
            entries.map((entry) => (
              <ApprovalRow
                key={entry.id}
                entry={entry}
                outcome={outcomes.get(entry.id)}
                selected={selected.has(entry.id)}
                onSelectedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) {
                    next.add(entry.id);
                  } else {
                    next.delete(entry.id);
                  }
                  onSelectedIdsChange([...next]);
                }}
                onApprove={onApprove}
                onReturn={onReturn}
                pending={pending}
                members={members}
                matters={matters}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
};

type ApprovalRowProps = Pick<
  ApprovalTableProps,
  "onApprove" | "onReturn" | "pending" | "members" | "matters"
> & {
  entry: ApprovalEntry;
  outcome: ApprovalResult | undefined;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
};
const ApprovalRow = ({
  entry,
  outcome,
  selected,
  onSelectedChange,
  onApprove,
  onReturn,
  pending,
  members,
  matters,
}: ApprovalRowProps) => {
  const selectionId = useId();
  const t = useTranslations();
  const format = useFormatter();
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <label
          htmlFor={selectionId}
          className="inline-flex min-h-11 min-w-11 items-center justify-center"
        >
          <Checkbox
            id={selectionId}
            aria-label={t("billing.approvalQueue.selectEntry")}
            checked={selected}
            disabled={pending}
            onCheckedChange={onSelectedChange}
          />
        </label>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {format.dateTime(
          Temporal.PlainDate.from(entry.dateWorked).toZonedDateTime("UTC")
            .epochMilliseconds,
          { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" },
        )}
      </TableCell>
      <TableCell>
        <BidiText>
          {entry.userId === null
            ? "—"
            : (members.get(entry.userId) ?? entry.userId)}
        </BidiText>
      </TableCell>
      <TableCell>
        <BidiText>
          {matters.get(entry.workspaceId) ?? entry.workspaceId}
        </BidiText>
      </TableCell>
      <TableCell className="max-w-md min-w-48 wrap-break-word whitespace-pre-wrap">
        <BidiText as="span">{entry.narrative}</BidiText>
        {entry.returnComment && (
          <BidiText as="p" className="text-muted-foreground mt-1 text-sm">
            {entry.returnComment}
          </BidiText>
        )}
        {outcome?.status === "refused" && (
          <p className="text-destructive mt-1 text-sm" role="alert">
            {t(APPROVAL_REFUSAL_KEYS[outcome.reason])}
          </p>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {format.number(entry.durationMinutes, {
          style: "unit",
          unit: "minute",
          unitDisplay: "short",
        })}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {format.number(entry.billedMinutes, {
          style: "unit",
          unit: "minute",
          unitDisplay: "short",
        })}
      </TableCell>
      <TableCell>
        <ReviewStatusBadge tone="neutral">
          {t(APPROVAL_STATUS_KEYS[entry.status])}
        </ReviewStatusBadge>
      </TableCell>
      <TableCell>
        <div className="flex gap-2">
          <Button
            className="min-h-11"
            disabled={pending}
            size="sm"
            variant="outline"
            onClick={() => onApprove([entry.id])}
          >
            {t("billing.approve")}
          </Button>
          <Button
            className="min-h-11"
            disabled={pending}
            size="sm"
            variant="ghost"
            onClick={() => onReturn(entry)}
          >
            {t("billing.approvalQueue.returnEntry")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
};

export const ApprovalTablePending = () => (
  <ApprovalTable
    entries={[]}
    results={[]}
    selectedIds={[]}
    onSelectedIdsChange={() => undefined}
    onApprove={() => undefined}
    onReturn={() => undefined}
    pending
    loading
    members={new Map()}
    matters={new Map()}
  />
);

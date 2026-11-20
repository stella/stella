import type { ReactNode } from "react";

import { ButtonFace, InputFace } from "@stll/ui/control-face";
import { FIELD_TRIGGER_CLASS_NAME } from "@stll/ui/field-trigger";
import { Frame, FramePanel } from "@stll/ui/frame";
import { CalendarIcon, ChevronsUpDownIcon, SearchIcon } from "@stll/ui/icons";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { RouteRowsPhase } from "@/lib/query-view.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

export const AUDIT_LOG_COLUMNS = [
  {
    id: "expand",
    label: "common.showDetails",
    bar: "w-4",
    headerClass: "w-10",
  },
  { id: "time", label: "settings.organization.auditLogsTime", bar: "w-24" },
  { id: "actor", label: "common.user", bar: "w-24" },
  { id: "action", label: "common.action", bar: "w-28" },
  {
    id: "resource",
    label: "settings.organization.auditLogsResourceType",
    bar: "w-24",
  },
  {
    id: "changes",
    label: "settings.organization.auditLogsChanges",
    bar: "w-32",
    headerClass: "w-full",
  },
] as const;

export const AuditLogSkeletonRows = ({
  previousPageEmpty = false,
}: {
  previousPageEmpty?: boolean;
}) => (
  <TableSkeletonRows
    columns={AUDIT_LOG_COLUMNS}
    count={previousPageEmpty ? 1 : undefined}
    rowClassName={cn(previousPageEmpty && "h-24")}
  />
);

export const AuditLogFiltersLayout = ({
  children,
}: {
  children: ReactNode;
}) => (
  <div className="bg-muted/30 grid grid-cols-1 items-end gap-2 rounded-lg border p-4 md:grid-cols-2 xl:grid-cols-4">
    {children}
  </div>
);

const FilterFace = ({
  children,
  label,
}: {
  children: ReactNode;
  label: ReactNode;
}) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <span className="text-foreground inline-flex text-xs font-medium sm:leading-4">
      {label}
    </span>
    {children}
  </div>
);

const SelectFilterFace = ({ children }: { children: ReactNode }) => (
  <span
    aria-hidden="true"
    className={cn(FIELD_TRIGGER_CLASS_NAME, "justify-between")}
    data-disabled=""
  >
    {children}
    <ChevronsUpDownIcon className="-me-1 size-4.5 opacity-80 sm:size-4" />
  </span>
);

const DateFilterFace = ({ label }: { label: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <span className="text-muted-foreground text-xs font-medium">{label}</span>
    <span
      aria-hidden="true"
      className="text-muted-foreground flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm opacity-64"
    >
      <CalendarIcon className="size-3.5 shrink-0" />
      <PendingText id="common.selectDate" />
    </span>
  </div>
);

const AuditLogFilterFaces = () => (
  <AuditLogFiltersLayout>
    <FilterFace label={<PendingText id="common.anonymizationLabels.person" />}>
      <InputFace icon={<SearchIcon />}>
        <PendingText id="settings.organization.auditLogsPersonPlaceholder" />
      </InputFace>
    </FilterFace>
    <FilterFace
      label={<PendingText id="settings.organization.auditLogsPerformer" />}
    >
      <SelectFilterFace>
        <PendingText id="settings.organization.auditLogsPerformerPeople" />
      </SelectFilterFace>
    </FilterFace>
    <FilterFace label={<PendingText id="common.action" />}>
      <SelectFilterFace>
        <PendingText id="settings.organization.auditLogsAllActions" />
      </SelectFilterFace>
    </FilterFace>
    <FilterFace
      label={<PendingText id="settings.organization.auditLogsResourceType" />}
    >
      <InputFace>
        <PendingText id="settings.organization.auditLogsResourceTypePlaceholder" />
      </InputFace>
    </FilterFace>
    <div className="flex flex-col gap-1.5 md:col-span-2">
      <DateFilterFace
        label={<PendingText id="settings.organization.auditLogsFrom" />}
      />
      <DateFilterFace
        label={<PendingText id="settings.organization.auditLogsTo" />}
      />
    </div>
  </AuditLogFiltersLayout>
);

export const AuditLogShell = ({
  exportAction,
  filters,
  next,
  phase,
  previous,
  rows,
}: {
  exportAction: ReactNode;
  filters: ReactNode;
  next: ReactNode;
  phase: RouteRowsPhase;
  previous: ReactNode;
  rows: ReactNode;
}) => (
  <>
    <div className="mb-6 flex items-center justify-between gap-4">
      <SettingsPageHeader
        description={
          <PendingText
            barClassName="w-56"
            id="settings.organization.auditLogsDescription"
          />
        }
        title={<PendingText id="settings.organization.auditLogs" />}
      />
      {exportAction}
    </div>
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-6">
          {filters}
          <div
            className={cn(
              "rounded-md border",
              phase === "stale" && "opacity-56",
            )}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  {AUDIT_LOG_COLUMNS.map((column) => (
                    <TableHead
                      className={cn(
                        "headerClass" in column && column.headerClass,
                      )}
                      key={column.id}
                    >
                      <span className={cn(column.id === "expand" && "sr-only")}>
                        <PendingText barClassName="w-12" id={column.label} />
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody aria-busy={phase !== "rows" || undefined}>
                {rows}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between px-2">
            {previous}
            {next}
          </div>
        </div>
      </FramePanel>
    </Frame>
  </>
);

export const AuditLogsPending = framePendingView(() => (
  <SettingsPagePending>
    <AuditLogShell
      exportAction={
        <ButtonFace size="default" variant="outline">
          <PendingText id="settings.organization.auditLogsExport" />
        </ButtonFace>
      }
      filters={<AuditLogFilterFaces />}
      next={
        <ButtonFace size="default" variant="outline">
          <PendingText id="common.next" />
        </ButtonFace>
      }
      phase="skeleton"
      previous={
        <ButtonFace size="default" variant="outline">
          <PendingText id="common.previous" />
        </ButtonFace>
      }
      rows={<AuditLogSkeletonRows />}
    />
  </SettingsPagePending>
));

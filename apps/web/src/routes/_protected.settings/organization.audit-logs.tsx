import { useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { Result } from "better-result";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/components/table";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { auditLogOptions, type fetchAuditLogs, type AuditLogsPageKey } from "@/routes/_protected.settings/-queries/audit-logs";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { getFormattingLocale } from "@/i18n/i18n-store";

export const Route = createFileRoute(
  "/_protected/settings/organization/audit-logs",
)({
  component: AuditLogsPage,
});

function AuditLogsPage() {
  const t = useTranslations();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const limit = 20;

  // Filter states
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterResourceType, setFilterResourceType] = useState<string>("");
  const [filterUserId, setFilterUserId] = useState<string>("");
  const [filterFrom, setFilterFrom] = useState<string | null>(null);
  const [filterTo, setFilterTo] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);

  const handleFilterChange = <T,>(setter: (val: T) => void, val: T) => {
    setter(val);
    setCursor(undefined);
    setCursorHistory([]);
  };

  const queryParams: AuditLogsPageKey = {
    limit,
    cursor,
    action: filterAction || undefined,
    resourceType: filterResourceType || undefined,
    userId: filterUserId || undefined,
    from: filterFrom ? new Date(filterFrom).toISOString() : undefined,
    to: filterTo ? new Date(filterTo).toISOString() : undefined,
  };

  const { data, isLoading, isError } = useQuery({
    ...auditLogOptions({ key: queryParams }),
    placeholderData: keepPreviousData,
  });

  const handleNextPage = () => {
    if (data?.nextCursor) {
      setCursorHistory((prev) => [...prev, cursor]);
      setCursor(data.nextCursor);
    }
  };

  const handlePrevPage = () => {
    setCursorHistory((prev) => {
      const nextHistory = [...prev];
      const prevCursor = nextHistory.pop();
      setCursor(prevCursor);
      return nextHistory;
    });
  };

  const handleExport = async () => {
    setExporting(true);
    const result = await Result.tryPromise(async () => {
      const cleanParams: Record<string, string> = {};
      if (filterAction) {cleanParams["action"] = filterAction;}
      if (filterResourceType) {cleanParams["resourceType"] = filterResourceType;}
      if (filterUserId) {cleanParams["userId"] = filterUserId;}
      if (filterFrom) {cleanParams["from"] = new Date(filterFrom).toISOString();}
      if (filterTo) {cleanParams["to"] = new Date(filterTo).toISOString();}

      const response = await api["audit-logs"].export.get({
        query: cleanParams,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    });

    setExporting(false);

    if (Result.isError(result)) {
      stellaToast.add({
        title: "Export failed",
        type: "error",
      });
      return;
    }

    if (result.value) {
      const blob = new Blob([result.value], { type: "text/csv;charset=utf-8;" });
      downloadFile(blob, "audit-logs.csv");
    }
  };

  return (
    <>
      <div className="flex justify-between items-center mb-6">
        <SettingsPageHeader
          description={t("settings.organization.auditLogsDescription")}
          title={t("settings.organization.auditLogs")}
        />
        <Button
          disabled={exporting}
          onClick={() => {
            void handleExport();
          }}
          variant="outline"
        >
          {exporting ? t("settings.organization.auditLogsExporting") : t("settings.organization.auditLogsExport")}
        </Button>
      </div>

      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-6">
            {/* Filters Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end bg-muted/30 p-4 rounded-lg border">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="userId-input">
                  {t("common.user")} ID
                </label>
                <Input
                  id="userId-input"
                  placeholder="Filter by User ID"
                  value={filterUserId}
                  onChange={(e) => handleFilterChange(setFilterUserId, e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="action-select">
                  {t("settings.organization.auditLogsAction")}
                </label>
                <Select
                  id="action-select"
                  value={filterAction || "all"}
                  onValueChange={(val) => handleFilterChange(setFilterAction, !val || val === "all" ? "" : val)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("settings.organization.auditLogsAllActions")} />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="all">{t("settings.organization.auditLogsAllActions")}</SelectItem>
                    <SelectItem value="create">{t("settings.organization.auditLogsActionCreate")}</SelectItem>
                    <SelectItem value="update">{t("settings.organization.auditLogsActionUpdate")}</SelectItem>
                    <SelectItem value="delete">{t("settings.organization.auditLogsActionDelete")}</SelectItem>
                    <SelectItem value="download">{t("settings.organization.auditLogsActionDownload")}</SelectItem>
                    <SelectItem value="execute">{t("settings.organization.auditLogsActionExecute")}</SelectItem>
                    <SelectItem value="access">{t("settings.organization.auditLogsActionAccess")}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="resourceType-input">
                  {t("settings.organization.auditLogsResourceType")}
                </label>
                <Input
                  id="resourceType-input"
                  placeholder="e.g. workspace"
                  value={filterResourceType}
                  onChange={(e) => handleFilterChange(setFilterResourceType, e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="from-input">
                  {t("settings.organization.auditLogsFrom")}
                </label>
                <DatePickerPopover
                  value={filterFrom}
                  onChange={(date) => handleFilterChange(setFilterFrom, date)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="to-input">
                  {t("settings.organization.auditLogsTo")}
                </label>
                <DatePickerPopover
                  value={filterTo}
                  onChange={(date) => handleFilterChange(setFilterTo, date)}
                />
              </div>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("settings.organization.auditLogsTime")}</TableHead>
                    <TableHead>{t("common.user")}</TableHead>
                    <TableHead>{t("settings.organization.auditLogsAction")}</TableHead>
                    <TableHead>{t("settings.organization.auditLogsResourceType")}</TableHead>
                    <TableHead>{t("settings.organization.auditLogsResourceId")}</TableHead>
                    <TableHead>{t("settings.organization.auditLogsChanges")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AuditLogsTableBody
                    isLoading={isLoading}
                    isError={isError}
                    data={data}
                  />
                </TableBody>
              </Table>
            </div>

            <div className="flex justify-between items-center px-2">
              <Button
                disabled={cursorHistory.length === 0 || isLoading}
                onClick={handlePrevPage}
                variant="outline"
              >
                {t("common.previous")}
              </Button>
              <Button
                disabled={!data?.nextCursor || isLoading}
                onClick={handleNextPage}
                variant="outline"
              >
                {t("common.next")}
              </Button>
            </div>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}

type AuditLogsTableBodyProps = {
  isLoading: boolean;
  isError: boolean;
  data: Awaited<ReturnType<typeof fetchAuditLogs>> | undefined;
};

function AuditLogsTableBody({ isLoading, isError, data }: AuditLogsTableBodyProps) {
  const t = useTranslations();
  if (isLoading) {
    return (
      <TableRow>
        <TableCell className="text-muted-foreground h-24 text-center" colSpan={6}>
          {t("settings.organization.auditLogsLoading")}
        </TableCell>
      </TableRow>
    );
  }

  if (isError) {
    return (
      <TableRow>
        <TableCell className="text-destructive h-24 text-center font-medium" colSpan={6}>
          {t("settings.organization.auditLogsError")}
        </TableCell>
      </TableRow>
    );
  }

  if (data === undefined || data.items.length === 0) {
    return (
      <TableRow>
        <TableCell className="text-muted-foreground h-24 text-center" colSpan={6}>
          {t("settings.organization.auditLogsEmpty")}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      {data.items.map((log) => (
        <TableRow key={log.id}>
          <TableCell className="whitespace-nowrap text-xs">
            {new Date(log.createdAt).toLocaleString(getFormattingLocale())}
          </TableCell>
          <TableCell className="text-xs font-mono">
            {log.user ? `${log.user.name} (${log.user.email})` : log.userId}
          </TableCell>
          <TableCell className="text-xs capitalize font-medium">{log.action}</TableCell>
          <TableCell className="text-xs">{log.resourceType}</TableCell>
          <TableCell className="text-xs font-mono max-w-[120px] truncate" title={log.resourceId}>
            {log.resourceId}
          </TableCell>
          <TableCell className="text-xs font-mono max-w-[200px] truncate" title={log.changes ? JSON.stringify(log.changes) : ""}>
            {log.changes ? JSON.stringify(log.changes) : "-"}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

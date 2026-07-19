import { useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

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

import { DatePickerPopover } from "@/components/date-picker-popover";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { APIError, unwrapEden } from "@/lib/errors/api";
import { prefetchRouteQuery } from "@/lib/react-query";
import { downloadFile } from "@/lib/utils";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { toAuditLogDateRange } from "@/routes/_protected.settings/-queries/audit-log-date-range";
import {
  auditLogOptions,
  type fetchAuditLogs,
  type AuditLogsPageKey,
} from "@/routes/_protected.settings/-queries/audit-logs";

export const Route = createFileRoute(
  "/_protected/settings/organization/audit-logs",
)({
  loader: async ({ context }) => {
    await prefetchRouteQuery(
      context.queryClient,
      auditLogOptions({ key: { limit: AUDIT_LOG_PAGE_LIMIT } }),
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    );
  },
  component: AuditLogsPage,
});

const AUDIT_LOG_PAGE_LIMIT = 20;

function AuditLogsPage() {
  const t = useTranslations();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>(
    [],
  );
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterResourceType, setFilterResourceType] = useState<string>("");
  const [filterUserId, setFilterUserId] = useState<string>("");
  const [filterFrom, setFilterFrom] = useState<string | null>(null);
  const [filterTo, setFilterTo] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const dateRange = toAuditLogDateRange({
    from: filterFrom,
    to: filterTo,
  });

  const handleFilterChange = <T,>(setter: (val: T) => void, val: T) => {
    setter(val);
    setCursor(undefined);
    setCursorHistory([]);
  };

  const queryParams: AuditLogsPageKey = {
    limit: AUDIT_LOG_PAGE_LIMIT,
    cursor,
    action: filterAction || undefined,
    resourceType: filterResourceType || undefined,
    userId: filterUserId || undefined,
    from: dateRange.from,
    toExclusive: dateRange.toExclusive,
  };

  const { data, isLoading, isError, isFetching } = useQuery({
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
    const result = await Result.tryPromise({
      try: async () => {
        const cleanParams: Record<string, string> = {};
        if (filterAction) {
          cleanParams["action"] = filterAction;
        }
        if (filterResourceType) {
          cleanParams["resourceType"] = filterResourceType;
        }
        if (filterUserId) {
          cleanParams["userId"] = filterUserId;
        }
        if (dateRange.from) {
          cleanParams["from"] = dateRange.from;
        }
        if (dateRange.toExclusive) {
          cleanParams["toExclusive"] = dateRange.toExclusive;
        }

        const response = await api["audit-logs"].export.get({
          query: cleanParams,
        });

        return unwrapEden(response);
      },
      catch: (error) => error,
    });

    setExporting(false);

    if (Result.isError(result)) {
      stellaToast.add({
        title:
          APIError.is(result.error) && result.error.status === 413
            ? t("settings.organization.auditLogsExportTooLarge")
            : t("settings.organization.auditLogsExportFailed"),
        type: "error",
      });
      return;
    }

    if (result.value) {
      const blob = new Blob([result.value], {
        type: "text/csv;charset=utf-8;",
      });
      downloadFile(blob, "audit-logs.csv");
    }
  };

  const handleExportClick = () => {
    void handleExport().catch((error: unknown) => {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: t("settings.organization.auditLogsExportFailed"),
        type: "error",
      });
    });
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <SettingsPageHeader
          description={t("settings.organization.auditLogsDescription")}
          title={t("settings.organization.auditLogs")}
        />
        <Button
          disabled={exporting}
          onClick={handleExportClick}
          variant="outline"
        >
          {exporting
            ? t("settings.organization.auditLogsExporting")
            : t("settings.organization.auditLogsExport")}
        </Button>
      </div>

      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-6">
            {/* Filters Row */}
            <div className="bg-muted/30 grid grid-cols-1 items-end gap-2 rounded-lg border p-4 md:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground text-xs font-medium"
                  htmlFor="userId-input"
                >
                  {t("settings.organization.auditLogsUserId")}
                </label>
                <Input
                  id="userId-input"
                  placeholder={t(
                    "settings.organization.auditLogsUserIdPlaceholder",
                  )}
                  value={filterUserId}
                  onChange={(e) =>
                    handleFilterChange(setFilterUserId, e.target.value)
                  }
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground text-xs font-medium"
                  htmlFor="action-select"
                >
                  {t("settings.organization.auditLogsAction")}
                </label>
                <Select
                  id="action-select"
                  value={filterAction || "all"}
                  onValueChange={(val) =>
                    handleFilterChange(
                      setFilterAction,
                      !val || val === "all" ? "" : val,
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={t(
                        "settings.organization.auditLogsAllActions",
                      )}
                    />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="all">
                      {t("settings.organization.auditLogsAllActions")}
                    </SelectItem>
                    <SelectItem value="create">
                      {t("settings.organization.auditLogsActionCreate")}
                    </SelectItem>
                    <SelectItem value="update">
                      {t("settings.organization.auditLogsActionUpdate")}
                    </SelectItem>
                    <SelectItem value="delete">
                      {t("settings.organization.auditLogsActionDelete")}
                    </SelectItem>
                    <SelectItem value="download">
                      {t("settings.organization.auditLogsActionDownload")}
                    </SelectItem>
                    <SelectItem value="execute">
                      {t("settings.organization.auditLogsActionExecute")}
                    </SelectItem>
                    <SelectItem value="access">
                      {t("settings.organization.auditLogsActionAccess")}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground text-xs font-medium"
                  htmlFor="resourceType-input"
                >
                  {t("settings.organization.auditLogsResourceType")}
                </label>
                <Input
                  id="resourceType-input"
                  placeholder={t(
                    "settings.organization.auditLogsResourceTypePlaceholder",
                  )}
                  value={filterResourceType}
                  onChange={(e) =>
                    handleFilterChange(setFilterResourceType, e.target.value)
                  }
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground text-xs font-medium"
                  htmlFor="from-input"
                >
                  {t("settings.organization.auditLogsFrom")}
                </label>
                <DatePickerPopover
                  value={filterFrom}
                  onChange={(date) => handleFilterChange(setFilterFrom, date)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-muted-foreground text-xs font-medium"
                  htmlFor="to-input"
                >
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
                    <TableHead>
                      {t("settings.organization.auditLogsTime")}
                    </TableHead>
                    <TableHead>{t("common.user")}</TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsAction")}
                    </TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsResourceType")}
                    </TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsResourceId")}
                    </TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsChanges")}
                    </TableHead>
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

            <div className="flex items-center justify-between px-2">
              <Button
                disabled={cursorHistory.length === 0 || isFetching}
                onClick={handlePrevPage}
                variant="outline"
              >
                {t("common.previous")}
              </Button>
              <Button
                disabled={!data?.nextCursor || isFetching}
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

function AuditLogsTableBody({
  isLoading,
  isError,
  data,
}: AuditLogsTableBodyProps) {
  const t = useTranslations();
  if (isLoading) {
    return (
      <TableRow>
        <TableCell
          className="text-muted-foreground h-24 text-center"
          colSpan={6}
        >
          {t("settings.organization.auditLogsLoading")}
        </TableCell>
      </TableRow>
    );
  }

  if (isError) {
    return (
      <TableRow>
        <TableCell
          className="text-destructive h-24 text-center font-medium"
          colSpan={6}
        >
          {t("settings.organization.auditLogsError")}
        </TableCell>
      </TableRow>
    );
  }

  if (data === undefined || data.items.length === 0) {
    return (
      <TableRow>
        <TableCell
          className="text-muted-foreground h-24 text-center"
          colSpan={6}
        >
          {t("settings.organization.auditLogsEmpty")}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      {data.items.map((log) => (
        <TableRow key={log.id}>
          <TableCell className="text-xs whitespace-nowrap">
            {new Date(log.createdAt).toLocaleString(getFormattingLocale())}
          </TableCell>
          <TableCell className="font-mono text-xs">
            <bdi>{log.actor}</bdi>
          </TableCell>
          <TableCell className="text-xs font-medium">
            <AuditActionLabel action={log.action} />
          </TableCell>
          <TableCell className="text-xs">
            <bdi>{log.resourceType}</bdi>
          </TableCell>
          <TableCell
            className="max-w-[120px] truncate font-mono text-xs"
            title={log.resourceId}
          >
            <bdi>{log.resourceId}</bdi>
          </TableCell>
          <TableCell
            className="max-w-[200px] truncate font-mono text-xs"
            title={log.changes ? JSON.stringify(log.changes) : ""}
          >
            <bdi>{log.changes ? JSON.stringify(log.changes) : "-"}</bdi>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function AuditActionLabel({ action }: { action: string }) {
  const t = useTranslations();

  if (action === "create") {
    return t("settings.organization.auditLogsActionCreate");
  }
  if (action === "update") {
    return t("settings.organization.auditLogsActionUpdate");
  }
  if (action === "delete") {
    return t("settings.organization.auditLogsActionDelete");
  }
  if (action === "download") {
    return t("settings.organization.auditLogsActionDownload");
  }
  if (action === "execute") {
    return t("settings.organization.auditLogsActionExecute");
  }
  if (action === "access") {
    return t("settings.organization.auditLogsActionAccess");
  }

  return <bdi>{action}</bdi>;
}

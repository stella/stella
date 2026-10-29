import { useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { AuditResource } from "@stll/api-contract/audit-log";
import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { DateRangeFilter } from "@/components/date-range-filter";
import { MatterRefLink } from "@/components/matter-ref-link";
import { SettingsPageHeader } from "@/components/settings-page-header";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { prefetchRouteQuery } from "@/lib/react-query";
import { downloadFile } from "@/lib/utils";
import { AuditChangeDetails } from "@/routes/_protected.admin/-components/audit-change-details";
import {
  AUDIT_ACTION_PROJECTIONS,
  AUDIT_RESOURCE_PROJECTIONS,
  isAuditAction,
  projectAuditResourceLabel,
} from "@/routes/_protected.admin/-components/audit-display-projection";
import { toAuditLogDateRange } from "@/routes/_protected.admin/-queries/audit-log-date-range";
import {
  auditLogOptions,
  type AuditLogsPageKey,
  type fetchAuditLogs,
} from "@/routes/_protected.admin/-queries/audit-logs";

export const Route = createFileRoute("/_protected/admin/audit-logs")({
  loader: async ({ context }) => {
    await prefetchRouteQuery(
      context.queryClient,
      auditLogOptions({
        viewer: {
          userId: context.user.id,
          organizationId: context.user.activeOrganizationId,
        },
        key: { limit: AUDIT_LOG_PAGE_LIMIT },
      }),
      (error: unknown) => {
        getAnalytics().captureError(error, {
          fingerprintKey: "admin.audit-logs.loader:failure",
          scope: {
            type: "request",
            method: "GET",
            routeTemplate: "/_protected/admin/audit-logs",
          },
        });
      },
    );
  },
  component: AuditLogsPage,
});

const AUDIT_LOG_PAGE_LIMIT = 20;

function AuditLogsPage() {
  const t = useTranslations();
  const user = useAuthenticatedUser();
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
    ...auditLogOptions({
      viewer: { userId: user.id, organizationId: user.activeOrganizationId },
      key: queryParams,
    }),
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

        return unwrapApiResponse(response);
      },
      catch: (error) => error,
    });

    setExporting(false);

    if (Result.isError(result)) {
      notifyUserError(
        result.error,
        APIError.is(result.error) && result.error.status === 413
          ? t("settings.organization.auditLogsExportTooLarge")
          : t("settings.organization.auditLogsExportFailed"),
      );
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
    detached(
      handleExport().catch((error: unknown) => {
        getAnalytics().captureError(error, {
          fingerprintKey: "AuditLogsPage.handleExportClick:failure",
          scope: {
            type: "handler",
            handlerId: "AuditLogsPage.handleExportClick:failure",
          },
        });
        notifyUserError(
          error,
          t("settings.organization.auditLogsExportFailed"),
        );
      }),
      "settings-organization-audit-logs.export",
    );
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
                  {t("common.action")}
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

              <DateRangeFilter
                className="md:col-span-2"
                from={filterFrom}
                to={filterTo}
                fromLabel={t("settings.organization.auditLogsFrom")}
                toLabel={t("settings.organization.auditLogsTo")}
                onFromChange={(date) => handleFilterChange(setFilterFrom, date)}
                onToChange={(date) => handleFilterChange(setFilterTo, date)}
              />
            </div>

            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("settings.organization.auditLogsTime")}
                    </TableHead>
                    <TableHead>{t("common.user")}</TableHead>
                    <TableHead>{t("common.action")}</TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsResourceType")}
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
  const format = useFormatter();
  if (isLoading) {
    return (
      <TableRow>
        <TableCell
          className="text-muted-foreground h-24 text-center"
          colSpan={5}
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
          colSpan={5}
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
          colSpan={5}
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
            {format.dateTime(new Date(log.createdAt).getTime(), {
              year: "numeric",
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "numeric",
              second: "numeric",
            })}
          </TableCell>
          <TableCell className="font-mono text-xs">
            <bdi>{log.actor}</bdi>
          </TableCell>
          <TableCell className="text-xs font-medium">
            <AuditActionSentence action={log.action} resource={log.resource} />
          </TableCell>
          <TableCell className="text-xs">
            <AuditResourceLabel action={log.action} resource={log.resource} />
          </TableCell>
          <AuditChangeDetails
            changes={log.changes}
            changesStatus={log.changesStatus}
          />
        </TableRow>
      ))}
    </>
  );
}

function AuditActionSentence({
  action,
  resource,
}: {
  action: string;
  resource: AuditLogResource;
}) {
  const t = useTranslations();
  const label = useAuditResourceLabel(action, resource);
  if (!isAuditAction(action)) {
    return t("settings.organization.auditLogsSentenceActivity", {
      resource: label,
    });
  }
  return t(AUDIT_ACTION_PROJECTIONS[action], { resource: label });
}

export function AuditResourceLabel({
  action,
  resource,
}: {
  action: string;
  resource: AuditLogResource;
}) {
  const t = useTranslations();
  const label = useAuditResourceLabel(action, resource);
  const shortId = resource.id.slice(0, 8);
  const content =
    resource.available && resource.kind === "workspace" ? (
      <MatterRefLink
        className="hover:underline focus-visible:underline"
        workspaceId={resource.id}
      >
        <bdi>{label}</bdi>
      </MatterRefLink>
    ) : (
      <bdi>{label}</bdi>
    );

  return (
    <div className="min-w-0">
      <div className="truncate font-medium">{content}</div>
      <div className="text-muted-foreground font-mono">
        {resource.kind === "unknown" ? <bdi>{resource.rawKind} · </bdi> : null}
        <span className="sr-only">
          {t("settings.organization.auditLogsResourceIdentifier", {
            id: resource.id,
          })}
        </span>
        <bdi aria-hidden="true" title={resource.id}>
          {shortId}
        </bdi>
      </div>
    </div>
  );
}

type AuditLogResource = AuditResource;

function useAuditResourceLabel(action: string, resource: AuditLogResource) {
  const t = useTranslations();
  if (resource.kind === "unknown") {
    return t("settings.organization.auditLogsUnknownResource");
  }
  return projectAuditResourceLabel({
    action,
    resource,
    deletedLabel: (kind) =>
      t("settings.organization.auditLogsDeletedResource", { kind }),
    kind: t(AUDIT_RESOURCE_PROJECTIONS[resource.kind]),
    unavailableLabel: (kind) =>
      t("settings.organization.auditLogsUnavailableResource", { kind }),
  });
}

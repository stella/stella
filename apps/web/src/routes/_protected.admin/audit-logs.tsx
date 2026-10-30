import { useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { AUDIT_PERFORMER_FILTER } from "@stll/api-contract/audit-log";
import type { AuditPerformerFilter } from "@stll/api-contract/audit-log";
import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Frame, FramePanel } from "@stll/ui/frame";
import { ChevronRightIcon } from "@stll/ui/icons";
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
import { cn } from "@stll/ui/utils";

import { DateRangeFilter } from "@/components/date-range-filter";
import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import { SettingsPageHeader } from "@/components/settings-page-header";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { organizationOptions } from "@/lib/organization/queries";
import { pageTitle } from "@/lib/page-title";
import { queryView } from "@/lib/query-view.logic";
import { prefetchRouteQuery } from "@/lib/react-query";
import { downloadFile } from "@/lib/utils";
import { routePresentation } from "@/routes/-route-presentation";
import {
  AuditChangeDetails,
  AuditChangeSummary,
} from "@/routes/_protected.admin/-components/audit-change-details";
import { toAuditLogDateRange } from "@/routes/_protected.admin/-queries/audit-log-date-range";
import {
  auditLogOptions,
  type AuditLogsPageKey,
  type fetchAuditLogs,
} from "@/routes/_protected.admin/-queries/audit-logs";

export const Route = createFileRoute("/_protected/admin/audit-logs")({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.auditLogs",
      to: "/admin/audit-logs",
    }),
  },
  loader: async ({ context }) => {
    await prefetchRouteQuery(
      context.queryClient,
      auditLogOptions({
        viewer: {
          userId: context.user.id,
          organizationId: context.user.activeOrganizationId,
        },
        key: {
          limit: AUDIT_LOG_PAGE_LIMIT,
          performer: DEFAULT_PERFORMER_FILTER,
        },
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
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.auditLogs") }],
  }),
  component: AuditLogsPage,
});

const AUDIT_LOG_PAGE_LIMIT = 20;
const AUDIT_LOG_COLUMN_COUNT = 6;

// Background services write far more rows than people do; the log opens on
// what members did and shows automations on request.
const DEFAULT_PERFORMER_FILTER = AUDIT_PERFORMER_FILTER.people;
const ALL_PERFORMERS = "all";

type PerformerChoice = AuditPerformerFilter | typeof ALL_PERFORMERS;

const toPerformerChoice = (value: string | null): PerformerChoice => {
  switch (value) {
    case AUDIT_PERFORMER_FILTER.automations:
      return AUDIT_PERFORMER_FILTER.automations;
    case ALL_PERFORMERS:
      return ALL_PERFORMERS;
    default:
      return DEFAULT_PERFORMER_FILTER;
  }
};

function AuditPersonFilter({
  value,
  onValueChange,
}: {
  value: string | null;
  onValueChange: (userId: string | null) => void;
}) {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const organizationView = queryView(
    useQuery(organizationOptions(user.activeOrganizationId)),
  );
  const members =
    organizationView.type === "items" ? organizationView.items.members : [];
  const memberOptions = members.map((member) => ({
    email: member.user.email,
    image: member.user.image ?? null,
    name: member.user.name,
    userId: member.userId,
  }));

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        className="text-muted-foreground text-xs font-medium"
        htmlFor="audit-person-filter"
      >
        {t("settings.organization.auditLogsPerson")}
      </label>
      <MemberCombobox
        choice={{
          type: MEMBER_CHOICE.memberOrNone,
          noneLabel: t("settings.organization.auditLogsAnyone"),
        }}
        id="audit-person-filter"
        label={t("settings.organization.auditLogsPerson")}
        members={memberOptions}
        onValueChange={onValueChange}
        placeholder={t("settings.organization.auditLogsPersonPlaceholder")}
        value={value}
      />
    </div>
  );
}

function AuditPerformerSelect({
  value,
  onValueChange,
}: {
  value: PerformerChoice;
  onValueChange: (choice: PerformerChoice) => void;
}) {
  const t = useTranslations();
  const choices = [
    {
      value: AUDIT_PERFORMER_FILTER.people,
      label: t("settings.organization.auditLogsPerformerPeople"),
    },
    {
      value: AUDIT_PERFORMER_FILTER.automations,
      label: t("settings.organization.auditLogsPerformerAutomations"),
    },
    {
      value: ALL_PERFORMERS,
      label: t("settings.organization.auditLogsPerformerAll"),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label
        className="text-muted-foreground text-xs font-medium"
        htmlFor="performer-select"
      >
        {t("settings.organization.auditLogsPerformer")}
      </label>
      <Select
        id="performer-select"
        items={choices}
        value={value}
        onValueChange={(val) => onValueChange(toPerformerChoice(val))}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function AuditLogsPage() {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>(
    [],
  );
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterResourceType, setFilterResourceType] = useState<string>("");
  const [filterUserId, setFilterUserId] = useState<string | null>(null);
  const [filterPerformer, setFilterPerformer] = useState<PerformerChoice>(
    DEFAULT_PERFORMER_FILTER,
  );
  const [filterFrom, setFilterFrom] = useState<string | null>(null);
  const [filterTo, setFilterTo] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const dateRange = toAuditLogDateRange({
    from: filterFrom,
    to: filterTo,
  });
  const performer =
    filterPerformer === ALL_PERFORMERS ? undefined : filterPerformer;

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
    userId: filterUserId ?? undefined,
    performer,
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
        if (performer) {
          cleanParams["performer"] = performer;
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
      <div className="mb-6 flex items-center justify-between gap-4">
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
            <div className="bg-muted/30 grid grid-cols-1 items-end gap-2 rounded-lg border p-4 md:grid-cols-2 xl:grid-cols-4">
              <AuditPersonFilter
                onValueChange={(userId) =>
                  handleFilterChange(setFilterUserId, userId)
                }
                value={filterUserId}
              />

              <AuditPerformerSelect
                onValueChange={(choice) =>
                  handleFilterChange(setFilterPerformer, choice)
                }
                value={filterPerformer}
              />

              <div className="flex min-w-0 flex-col gap-1.5">
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

              <div className="flex min-w-0 flex-col gap-1.5">
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
                    <TableHead className="w-10">
                      <span className="sr-only">
                        {t("settings.organization.auditLogsShowDetails")}
                      </span>
                    </TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsTime")}
                    </TableHead>
                    <TableHead>{t("common.user")}</TableHead>
                    <TableHead>{t("common.action")}</TableHead>
                    <TableHead>
                      {t("settings.organization.auditLogsResourceType")}
                    </TableHead>
                    <TableHead className="w-full">
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (isLoading) {
    return (
      <TableRow>
        <TableCell
          className="text-muted-foreground h-24 text-center"
          colSpan={AUDIT_LOG_COLUMN_COUNT}
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
          colSpan={AUDIT_LOG_COLUMN_COUNT}
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
          colSpan={AUDIT_LOG_COLUMN_COUNT}
        >
          {t("settings.organization.auditLogsEmpty")}
        </TableCell>
      </TableRow>
    );
  }

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });

  return (
    <>
      {data.items.map((log) => (
        <AuditLogRow
          isExpanded={expanded.has(log.id)}
          key={log.id}
          log={log}
          onToggle={() => toggle(log.id)}
        />
      ))}
    </>
  );
}

type AuditLogItem = Awaited<ReturnType<typeof fetchAuditLogs>>["items"][number];

function AuditLogRow({
  log,
  isExpanded,
  onToggle,
}: {
  log: AuditLogItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const detailsId = `audit-log-details-${log.id}`;
  const isAutomation = log.performerType === "service";

  return (
    <>
      <TableRow>
        <TableCell>
          <Button
            aria-controls={isExpanded ? detailsId : undefined}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t("settings.organization.auditLogsHideDetails")
                : t("settings.organization.auditLogsShowDetails")
            }
            onClick={onToggle}
            size="icon-sm"
            variant="ghost"
          >
            <DirectionalIcon
              className={cn(
                "text-muted-foreground transition-transform",
                isExpanded && "rotate-90",
              )}
              flip={!isExpanded}
              icon={ChevronRightIcon}
            />
          </Button>
        </TableCell>
        <TableCell className="text-xs whitespace-nowrap tabular-nums">
          {format.dateTime(new Date(log.createdAt).getTime(), {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
          })}
        </TableCell>
        <TableCell className="max-w-48 text-xs">
          <span className="line-clamp-2 wrap-anywhere">
            <bdi>{log.actor}</bdi>
          </span>
          {isAutomation ? (
            <span className="text-muted-foreground block">
              {t("settings.organization.auditLogsAutomation")}
            </span>
          ) : null}
        </TableCell>
        <TableCell className="text-xs font-medium">
          <AuditActionLabel action={log.action} />
        </TableCell>
        <TableCell className="text-xs">
          <bdi>{log.resourceType}</bdi>
        </TableCell>
        <TableCell className="max-w-0 text-xs">
          <AuditChangeSummary
            changes={log.changes}
            changesStatus={log.changesStatus}
          />
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow id={detailsId}>
          <TableCell
            className="bg-muted/30 text-xs whitespace-normal"
            colSpan={AUDIT_LOG_COLUMN_COUNT}
          >
            <div className="flex flex-col gap-3 py-1 ps-10">
              <DetailsGrid>
                <DetailsItem
                  label={t("settings.organization.auditLogsResourceId")}
                >
                  <bdi className="font-mono">{log.resourceId}</bdi>
                </DetailsItem>
                <DetailsItem
                  label={t("settings.organization.auditLogsActorId")}
                >
                  <bdi className="font-mono">{log.userId}</bdi>
                </DetailsItem>
              </DetailsGrid>
              <AuditChangeDetails
                changes={log.changes}
                changesStatus={log.changesStatus}
              />
            </div>
          </TableCell>
        </TableRow>
      ) : null}
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

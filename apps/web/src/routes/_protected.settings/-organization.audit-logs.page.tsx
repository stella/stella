import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { AUDIT_PERFORMER_FILTER } from "@stll/api-contract/audit-log";
import type { AuditResource } from "@stll/api-contract/audit-log";
import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
// oxlint-disable-next-line settings-layout-primitives/settings-layout-primitives -- the audit log compares time, actor, action and target across columns
import { TableCell, TableRow } from "@stll/ui/table";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { DateRangeFilter } from "@/components/date-range-filter";
import { MatterRefLink } from "@/components/matter-ref-link";
import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import type { MemberOption } from "@/components/member-combobox";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { organizationOptions } from "@/lib/organization/queries";
import { queryView, routeRowsPhase } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";
import { downloadFile } from "@/lib/utils";
import {
  ALL_PERFORMERS,
  AUDIT_LOG_PAGE_LIMIT,
  DEFAULT_PERFORMER_FILTER,
  toPerformerChoice,
} from "@/routes/_protected.settings/-organization.audit-logs.logic";
import type { PerformerChoice } from "@/routes/_protected.settings/-organization.audit-logs.logic";
import {
  AuditChangeDetails,
  AuditChangeSummary,
} from "@/routes/_protected.settings/organization/-components/audit-change-details";
import {
  AUDIT_ACTION_PROJECTIONS,
  AUDIT_RESOURCE_PROJECTIONS,
  isAuditAction,
  projectAuditResourceLabel,
} from "@/routes/_protected.settings/organization/-components/audit-display-projection";
import { auditPersonOptions } from "@/routes/_protected.settings/organization/-components/audit-person-options.logic";
import { toAuditLogDateRange } from "@/routes/_protected.settings/organization/-queries/audit-log-date-range";
import {
  auditLogOptions,
  type AuditLogsPageKey,
  type fetchAuditLogs,
} from "@/routes/_protected.settings/organization/-queries/audit-logs";

import {
  AUDIT_LOG_COLUMNS,
  AuditLogFiltersLayout,
  AuditLogShell,
  AuditLogSkeletonRows,
} from "./-organization.audit-logs.pending";

const AUDIT_LOG_COLUMN_COUNT = AUDIT_LOG_COLUMNS.length;

function AuditPersonFilter({
  value,
  entries,
  onValueChange,
}: {
  value: MemberOption | null;
  entries: readonly AuditLogItem[] | undefined;
  onValueChange: (person: MemberOption | null) => void;
}) {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const organizationView = queryView(
    useQuery(organizationOptions(user.activeOrganizationId)),
  );
  const members =
    organizationView.type === "items" ? organizationView.items.members : [];
  const personOptions = auditPersonOptions({
    members: members.map((member) => ({
      email: member.user.email,
      image: member.user.image ?? null,
      name: member.user.name,
      userId: member.userId,
    })),
    entries,
    selected: value,
  });

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className="text-xs" htmlFor="audit-person-filter">
        {t("common.anonymizationLabels.person")}
      </Label>
      <MemberCombobox
        choice={{
          type: MEMBER_CHOICE.memberOrNone,
          noneLabel: t("settings.organization.auditLogsAnyone"),
        }}
        id="audit-person-filter"
        label={t("common.anonymizationLabels.person")}
        members={personOptions}
        onValueChange={(userId) =>
          onValueChange(
            personOptions.find((option) => option.userId === userId) ?? null,
          )
        }
        placeholder={t("settings.organization.auditLogsPersonPlaceholder")}
        selectedFallback={value}
        value={value?.userId ?? null}
      />
      {organizationView.type === "pending" ? (
        <div className="sr-only">
          <QueryViewFeedback view={organizationView} />
        </div>
      ) : (
        <QueryViewFeedback view={organizationView} />
      )}
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
      <Label className="text-xs" htmlFor="performer-select">
        {t("settings.organization.auditLogsPerformer")}
      </Label>
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

export function AuditLogsPage() {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.at(-1);
  const [filterAction, setFilterAction] = useState<string>("");
  const [filterResourceType, setFilterResourceType] = useState<string>("");
  const [filterPerson, setFilterPerson] = useState<MemberOption | null>(null);
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
    setCursors([]);
  };

  const queryParams: AuditLogsPageKey = {
    limit: AUDIT_LOG_PAGE_LIMIT,
    cursor,
    action: filterAction || undefined,
    resourceType: filterResourceType || undefined,
    userId: filterPerson?.userId,
    performer,
    from: dateRange.from,
    toExclusive: dateRange.toExclusive,
  };

  const {
    data,
    error: queryError,
    isPending,
    isPlaceholderData,
    status,
    isFetching,
    refetch,
  } = useQuery({
    ...auditLogOptions({
      viewer: { userId: user.id, organizationId: user.activeOrganizationId },
      key: queryParams,
    }),
  });

  const phase = routeRowsPhase({
    routeState: "loaded",
    isLoading: isPending,
    isPlaceholderData,
    keptRowCount: data?.items.length ?? 0,
  });
  const pagingDisabled = isFetching || isPlaceholderData;

  let tableRows: AuditTableRows;
  switch (status) {
    case "pending":
      tableRows = { type: "pending", previousPageEmpty: false };
      break;
    case "error":
      tableRows = { type: "error", error: queryError, retry: refetch };
      break;
    case "success":
      tableRows =
        phase === "skeleton"
          ? { type: "pending", previousPageEmpty: true }
          : { type: "rows", items: data.items };
      break;
    default:
      status satisfies never;
      return panic("Unknown audit log query status");
  }

  const handleNextPage = () => {
    const nextCursor = data?.nextCursor;
    if (nextCursor) {
      setCursors((previous) => [...previous, nextCursor]);
    }
  };

  const handlePrevPage = () => {
    setCursors((previous) => previous.slice(0, -1));
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
        if (filterPerson) {
          cleanParams["userId"] = filterPerson.userId;
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
    <AuditLogShell
      exportAction={
        <Button
          disabled={exporting}
          onClick={handleExportClick}
          variant="outline"
        >
          {exporting
            ? t("settings.organization.auditLogsExporting")
            : t("settings.organization.auditLogsExport")}
        </Button>
      }
      filters={
        <AuditLogFiltersLayout>
          <AuditPersonFilter
            entries={data?.items}
            onValueChange={(person) =>
              handleFilterChange(setFilterPerson, person)
            }
            value={filterPerson}
          />

          <AuditPerformerSelect
            onValueChange={(choice) =>
              handleFilterChange(setFilterPerformer, choice)
            }
            value={filterPerformer}
          />

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label className="text-xs" htmlFor="action-select">
              {t("common.action")}
            </Label>
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
                  placeholder={t("settings.organization.auditLogsAllActions")}
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
                <SelectItem value="access">{t("common.access")}</SelectItem>
              </SelectPopup>
            </Select>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label className="text-xs" htmlFor="resourceType-input">
              {t("settings.organization.auditLogsResourceType")}
            </Label>
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
        </AuditLogFiltersLayout>
      }
      next={
        <Button
          disabled={!data?.nextCursor || pagingDisabled}
          onClick={handleNextPage}
          variant="outline"
        >
          {t("common.next")}
        </Button>
      }
      phase={phase}
      previous={
        <Button
          disabled={cursors.length === 0 || pagingDisabled}
          onClick={handlePrevPage}
          variant="outline"
        >
          {t("common.previous")}
        </Button>
      }
      rows={<AuditLogsTableBody state={tableRows} />}
    />
  );
}

type AuditLogPage = Awaited<ReturnType<typeof fetchAuditLogs>>;
type AuditLogItem = AuditLogPage["items"][number];

type AuditTableRows =
  | { type: "pending"; previousPageEmpty: boolean }
  | Extract<QueryView<AuditLogPage, Error>, { type: "error" }>
  | { type: "rows"; items: readonly AuditLogItem[] };

function AuditLogsTableBody({ state }: { state: AuditTableRows }) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  switch (state.type) {
    case "pending":
      return (
        <AuditLogSkeletonRows previousPageEmpty={state.previousPageEmpty} />
      );
    case "error":
      return (
        <TableRow>
          <TableCell
            className="text-destructive h-24 text-center font-medium"
            colSpan={AUDIT_LOG_COLUMN_COUNT}
          >
            <QueryViewFeedback view={state} />
          </TableCell>
        </TableRow>
      );
    case "rows": {
      if (state.items.length === 0) {
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
      return state.items.map((log) => (
        <AuditLogRow
          isExpanded={expanded.has(log.id)}
          key={log.id}
          log={log}
          onToggle={() => toggle(log.id)}
        />
      ));
    }
    default:
      state satisfies never;
      return panic("Unknown audit log table state");
  }
}

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

  const cells = {
    expand: {
      content: (
        <Button
          aria-controls={isExpanded ? detailsId : undefined}
          aria-expanded={isExpanded}
          aria-label={
            isExpanded ? t("common.hideDetails") : t("common.showDetails")
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
      ),
    },
    time: {
      className: "text-xs whitespace-nowrap tabular-nums",
      content: format.dateTime(new Date(log.createdAt).getTime(), {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      }),
    },
    actor: {
      className: "max-w-48 text-xs",
      content: (
        <>
          <TruncatedText className="wrap-anywhere" lines={2}>
            <bdi>{log.actor}</bdi>
          </TruncatedText>
          {isAutomation ? (
            <span className="text-muted-foreground block">
              {t("workspaces.overview.activity.filters.automation")}
            </span>
          ) : null}
        </>
      ),
    },
    action: {
      className: "text-xs font-medium",
      content: (
        <AuditActionSentence action={log.action} resource={log.resource} />
      ),
    },
    resource: {
      className: "text-xs",
      content: (
        <AuditResourceLabel action={log.action} resource={log.resource} />
      ),
    },
    changes: {
      className: "max-w-0 text-xs",
      content: (
        <AuditChangeSummary
          changes={log.changes}
          changesStatus={log.changesStatus}
        />
      ),
    },
  } as const;

  return (
    <>
      <TableRow>
        {AUDIT_LOG_COLUMNS.map(({ id }) => {
          const cell = cells[id];
          return (
            <TableCell
              className={cn("className" in cell && cell.className)}
              key={id}
            >
              {cell.content}
            </TableCell>
          );
        })}
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

export function AuditActionSentence({
  action,
  resource,
}: {
  action: string;
  resource: AuditLogResource;
}) {
  const t = useTranslations();
  const label = useAuditResourceLabel(action, resource, "sentence");
  if (!isAuditAction(action)) {
    // Keep the recorded action visible so retired or newer actions stay
    // distinguishable in the log.
    return (
      <>
        {t("settings.organization.auditLogsSentenceActivity", {
          resource: label,
        })}{" "}
        <bdi className="text-muted-foreground font-mono">{action}</bdi>
      </>
    );
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
      <TruncatedText className="font-medium" render={<div />}>
        {content}
      </TruncatedText>
      <div className="text-muted-foreground font-mono">
        {resource.kind === "unknown" ? <bdi>{resource.rawKind} · </bdi> : null}
        <span className="sr-only">
          {t("settings.organization.auditLogsResourceIdentifier", {
            id: resource.id,
          })}
        </span>
        {/* CSS truncation keeps the full id selectable for copying. */}
        <TruncatedText
          aria-hidden="true"
          className="inline-block max-w-[120px] align-bottom"
          render={<bdi />}
        >
          {resource.id}
        </TruncatedText>
      </div>
    </div>
  );
}

type AuditLogResource = AuditResource;

/**
 * `sentence` is for the object of an action sentence, which already says the
 * resource was deleted ("Deleted contact."); a standalone label says it itself
 * ("deleted contact").
 */
function useAuditResourceLabel(
  action: string,
  resource: AuditLogResource,
  placement: "label" | "sentence" = "label",
) {
  const t = useTranslations();
  if (resource.kind === "unknown") {
    return t("settings.organization.auditLogsUnknownResource");
  }
  return projectAuditResourceLabel({
    action,
    resource,
    deletedLabel: (kind) =>
      placement === "sentence"
        ? kind
        : t("settings.organization.auditLogsDeletedResource", { kind }),
    kind: t(AUDIT_RESOURCE_PROJECTIONS[resource.kind]),
    unavailableLabel: (kind) =>
      t("settings.organization.auditLogsUnavailableResource", { kind }),
  });
}

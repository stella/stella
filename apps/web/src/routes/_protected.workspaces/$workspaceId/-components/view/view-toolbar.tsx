import type { ComponentType, RefObject } from "react";
import { Fragment, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { PlaybookRunProjection } from "@stll/api-contract";
import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import {
  AlignJustifyIcon,
  CalendarIcon,
  ClockIcon,
  DownloadIcon,
  HashIcon,
  PlayIcon,
  Rows3Icon,
  SparklesIcon,
  UserIcon,
  AiActionIcon,
  WrapTextIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";
import { ViewToolbarChrome } from "@stll/ui/view-toolbar";

import { CsvIcon, DocxIcon, XlsxIcon } from "@/components/document-icon";
import { FolderExpandToggle } from "@/components/file-tree/folder-expand-toggle";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { AiColumnSelectionAction } from "@/components/workspaces/ai-column-run-controls";
import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import { getInternalPropertyId } from "@/components/workspaces/entity-utils";
import { useStartWorkflow } from "@/components/workspaces/hooks/use-start-workflow";
import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { RowActions } from "@/components/workspaces/row-actions";
import { ColumnToggle } from "@/components/workspaces/table/column-toggle";
import type { ColumnToggleGroup } from "@/components/workspaces/table/column-toggle";
import {
  GroupByControl,
  KanbanGroupingSettings,
} from "@/components/workspaces/view-grouping-controls";
import { FilterChips } from "@/components/workspaces/view-toolbar-filters";
import { useLocale } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { normalizeOptionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import type { ToAPIErrorProps } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { getExportBaseName, getExportFileName } from "@/lib/export-download";
import {
  PLAYBOOK_PICKER_LIMIT,
  playbooksOptions,
} from "@/lib/knowledge/queries";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";
import { toSafeId } from "@/lib/safe-id";
import type {
  ViewLayout,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { useQueryView } from "@/lib/use-query-view";
import { downloadFile } from "@/lib/utils";
import { useUpdateView } from "@/lib/workspaces/mutations/views";
import {
  workspaceFilesOptions,
  workspaceFoldersOptions,
} from "@/lib/workspaces/queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/lib/workspaces/queries/properties";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import type { TableContentMode } from "@/lib/workspaces/table-store";
import { useTableStore } from "@/lib/workspaces/table-store";
import { isTableView, mergeLayout } from "@/lib/workspaces/view-layout";
import { ExistingFileOrganizerDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog";
import { ExtractionRunProgress } from "@/routes/_protected.workspaces/$workspaceId/-components/extraction-run-progress";
import { ExportReportControl } from "@/routes/_protected.workspaces/$workspaceId/-components/view/export-report-dialog";
import { admitsOnlyTaskKind } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";
import { ViewToolbarSearch } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-search";
import { SortChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-sorts";

const protectedRouteApi = getRouteApi("/_protected");

type ViewToolbarProps = {
  /** The pane this toolbar and its view body share; the find bar's root. */
  paneRef: RefObject<HTMLElement | null>;
  view: WorkspaceView;
  workspaceId: string;
};

export const ViewToolbar = ({
  paneRef,
  view,
  workspaceId,
}: ViewToolbarProps) => {
  const propertiesQuery = useQuery(propertiesOptions(workspaceId));
  const propertiesView = useQueryView(propertiesQuery);
  const properties =
    propertiesView.type === "items" ? propertiesView.items : [];
  const updateView = useUpdateView(workspaceId);
  const { filters, sorts, hiddenProperties } = view.layout;
  const folderState = useWorkspaceStore((s) => s.folderState);
  const toggleAllFolders = useWorkspaceStore((s) => s.toggleAllFolders);
  const selectedEntities = useTableStore(
    (s) => s.selectedEntities[workspaceId]?.[view.id],
  );
  // Assignee sub-grouping needs a board scoped to tasks alone (see
  // kanban-view.logic.ts's `assigneeGroup`); a view admitting several kinds,
  // or one that does not provably restrict its kinds, does not offer it.
  const allowAssigneeGrouping = admitsOnlyTaskKind(filters);

  const handleUpdate = (changes: Partial<ViewLayout>) => {
    updateView.mutate({
      viewId: view.id,
      layout: mergeLayout(view.layout, changes),
    });
  };
  const columnToggleGroups = useMatterColumnToggleGroups(properties);
  const aiProperties =
    view.layout.type === "table"
      ? properties.filter(
          (property) =>
            property.tool.type === "ai-model" &&
            !hiddenProperties.includes(property.id),
        )
      : [];

  return (
    <ViewToolbarChrome
      className="md:ms-auto md:justify-end"
      data-slot="workspace-view-toolbar"
    >
      <QueryViewFeedback view={propertiesView} />
      <ExtractionRunProgress workspaceId={workspaceId} />

      {view.layout.type === "filesystem" && folderState.hasFolders && (
        <>
          <FolderExpandToggle
            allExpanded={folderState.allExpanded}
            onToggle={toggleAllFolders}
          />
          <span className="bg-border mx-1 h-4 w-px" />
        </>
      )}

      {isTableView(view) && (
        <ViewToolbarSearch
          paneRef={paneRef}
          properties={properties}
          view={view}
          workspaceId={workspaceId}
        />
      )}

      <FilterChips
        facetContext={{ workspaceId, filters }}
        filters={filters}
        onUpdate={(updatedFilters) => handleUpdate({ filters: updatedFilters })}
        properties={properties}
      />

      <SortChips
        onUpdate={(updatedSorts) => handleUpdate({ sorts: updatedSorts })}
        properties={properties}
        sorts={sorts}
      />

      <ColumnToggle
        groups={columnToggleGroups}
        hidden={hiddenProperties}
        onChange={(next) => handleUpdate({ hiddenProperties: next })}
      />

      {view.layout.type === "kanban" && (
        <>
          <span className="bg-border mx-1 h-4 w-px" />
          <KanbanGroupingSettings
            allowAssigneeGrouping={allowAssigneeGrouping}
            groupByPropertyId={view.layout.groupByPropertyId}
            onChange={(groupByPropertyId, subgroupByPropertyId) =>
              handleUpdate({ groupByPropertyId, subgroupByPropertyId })
            }
            properties={properties}
            subgroupByPropertyId={view.layout.subgroupByPropertyId}
          />
        </>
      )}

      {view.layout.type === "calendar" && (
        <>
          <span className="bg-border mx-1 h-4 w-px" />
          <CalendarDatePropertyControl
            datePropertyId={view.layout.datePropertyId}
            endDatePropertyId={view.layout.endDatePropertyId}
            onChange={(datePropertyId, endDatePropertyId) =>
              handleUpdate({ datePropertyId, endDatePropertyId })
            }
            properties={properties}
          />
          <AdditionalDatesControl
            additionalDatePropertyIds={normalizeOptionalArray(
              view.layout.additionalDatePropertyIds,
            )}
            onChange={(additionalDatePropertyIds) =>
              handleUpdate({ additionalDatePropertyIds })
            }
            primaryDatePropertyId={view.layout.datePropertyId}
            properties={properties}
          />
          <CalendarModeControl
            mode={view.layout.mode}
            onChange={(mode) => handleUpdate({ mode })}
          />
        </>
      )}

      {view.layout.type === "timeline" && (
        <>
          <span className="bg-border mx-1 h-4 w-px" />
          <TimelineDatePropertyControl
            endDatePropertyId={view.layout.endDatePropertyId}
            onChange={(startDatePropertyId, endDatePropertyId) =>
              handleUpdate({
                startDatePropertyId,
                endDatePropertyId,
              })
            }
            properties={properties}
            startDatePropertyId={view.layout.startDatePropertyId}
          />
          <TimelineZoomControl
            onChange={(zoom) => handleUpdate({ zoom })}
            zoom={view.layout.zoom}
          />
        </>
      )}

      {view.layout.type === "filesystem" && (
        <>
          <span className="bg-border mx-1 h-4 w-px" />
          <FilesystemOrganizerAction workspaceId={workspaceId} />
        </>
      )}

      {/* "+ Nový sloupec" mirrors the toolbar's chip-shaped chrome
          and lives next to the data-shape controls (filters, sorts,
          property visibility) so adding a column is reachable from
          the same row, not just the small "+" cell at the right edge
          of the table header. */}
      {view.layout.type === "table" && (
        <>
          <span className="bg-border mx-1 h-4 w-px" />
          <GroupByControl
            allowMultiSelectGrouping
            allowNone
            excludedPropertyId={getInternalPropertyId("status")}
            groupByPropertyId={view.layout.groupByPropertyId}
            onChange={(groupByPropertyId) =>
              handleUpdate(
                groupByPropertyId
                  ? { groupByPropertyId }
                  : { groupByPropertyId: undefined },
              )
            }
            properties={properties}
          />
          <TableContentModeControl viewId={view.id} workspaceId={workspaceId} />
          <TableExportMenu view={view} workspaceId={workspaceId} />
          <RunPlaybookControl workspaceId={workspaceId} />
          <BulkAddColumns
            target={{ kind: "workspace", workspaceId }}
            triggerVariant="labelled"
          />
        </>
      )}

      {view.layout.type === "table" && (
        <SelectionActions
          aiProperties={aiProperties}
          selectedEntities={selectedEntities}
          workspaceId={workspaceId}
        />
      )}
    </ViewToolbarChrome>
  );
};

type SelectionActionsProps = {
  aiProperties: readonly WorkspaceProperty[];
  selectedEntities: WorkspaceEntity[] | undefined;
  workspaceId: string;
};

/**
 * Secondary actions for the current row selection (delete, copy/move
 * to matter, download, …). Reuses the row actions menu so the
 * toolbar and the row context menu cannot drift apart.
 */
const SelectionActions = ({
  aiProperties,
  selectedEntities,
  workspaceId,
}: SelectionActionsProps) => {
  const t = useTranslations();
  const startWorkflow = useStartWorkflow(workspaceId);
  const [isRunningAIColumns, setIsRunningAIColumns] = useState(false);
  const firstSelected = selectedEntities?.at(0);
  if (!firstSelected || selectedEntities === undefined) {
    return null;
  }
  const selectedRunRows = selectedEntities.filter(
    (entity) => entity.kind !== "folder" && !entity.readOnly,
  );
  const aiPropertyIds = aiProperties.map((property) => property.id);
  const runSelectedAIColumns = async () => {
    if (aiPropertyIds.length === 0 || selectedRunRows.length === 0) {
      return;
    }
    setIsRunningAIColumns(true);
    try {
      const result = await startWorkflow({
        entityIds: selectedRunRows.map((entity) => entity.entityId),
        propertyIds: aiPropertyIds,
      });
      if (!result) {
        return;
      }
      switch (result.status) {
        case "started":
          stellaToast.add({
            title: t("workspaces.workflow.startedSuccessfully"),
            type: "success",
          });
          return;
        case "already-running":
          stellaToast.add({ title: t("common.running"), type: "info" });
          return;
        case "skipped":
          stellaToast.add({
            title: t("workspaces.workflow.noFieldsToProcess"),
            type: "info",
          });
          return;
        case "ai-unavailable":
        case "failed":
          return;
        default: {
          result satisfies never;
          panic("Unhandled workflow start status");
        }
      }
    } finally {
      setIsRunningAIColumns(false);
    }
  };

  return (
    <div className="relative ms-auto flex items-center gap-1.5">
      {/* The bulk actions behind the "…" menu stay invisible until a
          row is selected, so nothing signals that selecting rows
          unlocked them. This group only mounts once something is
          selected, which makes mount the 0 → 1 transition: a double
          tint blink then points at the count and the menu exactly
          once per selection, without any timer state. */}
      <div
        aria-hidden
        className="bg-primary/12 animate-attention-flash-twice pointer-events-none absolute -inset-x-1.5 -inset-y-1 rounded-md opacity-0 motion-reduce:animate-none"
      />
      <span className="text-muted-foreground relative text-xs">
        {t("workspaces.views.fieldsSelected", {
          count: selectedEntities.length,
        })}
      </span>
      {aiPropertyIds.length > 0 && (
        <div className="flex flex-col items-start gap-0.5">
          <AiColumnSelectionAction
            columns={aiPropertyIds.length}
            rows={selectedRunRows.length}
            disabled={isRunningAIColumns || selectedRunRows.length === 0}
            onRun={() =>
              detached(
                runSelectedAIColumns(),
                "view-toolbar.run-selected-ai-columns",
              )
            }
          />
        </div>
      )}
      <RowActions
        entity={firstSelected}
        selectedEntities={
          selectedEntities.length > 1 ? selectedEntities : undefined
        }
        triggerClassName="relative"
        workspaceId={workspaceId}
      />
    </div>
  );
};

// -- Layout-specific controls --

type TableContentModeControlProps = {
  workspaceId: string;
  viewId: string;
};

const TABLE_CONTENT_MODE_OPTIONS = [
  {
    mode: "tight",
    icon: AlignJustifyIcon,
    labelKey: "workspaces.table.tightContent",
  },
  {
    mode: "fit-content",
    icon: WrapTextIcon,
    labelKey: "workspaces.table.wrapContent",
  },
] as const satisfies readonly {
  mode: TableContentMode;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
}[];

const TableContentModeControl = ({
  workspaceId,
  viewId,
}: TableContentModeControlProps) => {
  const t = useTranslations();
  const viewRef = { workspaceId, viewId };
  const mode = useTableStore(
    (s) => s.contentMode[workspaceId]?.[viewId] ?? "tight",
  );
  const setMode = useTableStore((s) => s.setContentMode);

  return (
    <SegmentedIconToggle
      onChange={(next) => setMode(viewRef, next)}
      options={TABLE_CONTENT_MODE_OPTIONS.map((option) => ({
        value: option.mode,
        icon: option.icon,
        label: t(option.labelKey),
      }))}
      value={mode}
    />
  );
};

type TableExportFormat = "csv" | "xlsx" | "docx";

// One row per downloadable format, in menu order. `separatorBefore` splits the
// spreadsheet formats from the document formats.
const TABLE_EXPORT_FORMATS = [
  {
    format: "csv",
    icon: CsvIcon,
    labelKey: "workspaces.views.exportCsv",
    separatorBefore: false,
  },
  {
    format: "xlsx",
    icon: XlsxIcon,
    labelKey: "workspaces.views.exportXlsx",
    separatorBefore: false,
  },
  {
    format: "docx",
    icon: DocxIcon,
    labelKey: "workspaces.views.exportDocxPlain",
    separatorBefore: true,
  },
] as const satisfies readonly {
  format: TableExportFormat;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
  separatorBefore: boolean;
}[];

type ExportFormatIconProps = {
  Icon: ComponentType<{ className?: string }>;
  pending: boolean;
};

// The file-type icons carry their own colours, so `opacity-100` opts them out
// of the menu's default icon dimming. The spinner is the only signal that an
// export is running, so it is labelled rather than left aria-hidden.
const ExportFormatIcon = ({ Icon, pending }: ExportFormatIconProps) => {
  const t = useTranslations();

  if (pending) {
    return (
      <Loader
        className="size-4.5 sm:size-4"
        label={t("common.loading")}
        size="sm"
      />
    );
  }

  return <Icon className="size-4.5 opacity-100 sm:size-4" />;
};

type TableExportMenuProps = {
  view: Pick<WorkspaceView, "id" | "name">;
  workspaceId: string;
};

const TableExportMenu = ({ view, workspaceId }: TableExportMenuProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const analytics = useAnalytics();
  const [exportingFormat, setExportingFormat] =
    useState<TableExportFormat | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const handleExport = async (format: TableExportFormat) => {
    setExportingFormat(format);
    const result = await Result.tryPromise(async () => {
      const url = new URL(
        apiUrl(`/views/${workspaceId}/view/${view.id}/export`),
      );
      url.searchParams.set("format", format);

      const response = await fetchWithTimeout(url, {
        credentials: "include",
        headers: {
          "Accept-Language": locale,
        },
        timeoutMs: 60_000,
      });
      if (!response.ok) {
        throw new ClientOperationError({
          action: "exportTableView",
          message: "Failed to export table view",
        });
      }

      return {
        blob: await response.blob(),
        fileName:
          getExportFileName(response.headers.get("Content-Disposition")) ??
          `${getExportBaseName(view.name)}.${format}`,
      };
    });

    setExportingFormat(null);

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      notifyUserError(result.error, t("workspaces.views.exportFailed"));
      return;
    }

    downloadFile(result.value.blob, result.value.fileName);
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-busy={exportingFormat !== null}
              aria-label={t("workspaces.views.exportTable")}
              disabled={exportingFormat !== null}
              size="icon-xs"
              title={t("workspaces.views.exportTable")}
              variant="ghost"
            />
          }
        >
          {exportingFormat === null ? (
            <DownloadIcon className="size-3.5" />
          ) : (
            <Loader className="size-3.5" size="sm" variant="decorative" />
          )}
        </MenuTrigger>
        <MenuPopup className="min-w-56">
          {TABLE_EXPORT_FORMATS.map((option) => (
            <Fragment key={option.format}>
              {option.separatorBefore ? <MenuSeparator /> : null}
              <MenuItem
                closeOnClick={false}
                disabled={exportingFormat !== null}
                onClick={() => {
                  detached(handleExport(option.format), "view-toolbar.export");
                }}
              >
                <ExportFormatIcon
                  Icon={option.icon}
                  pending={exportingFormat === option.format}
                />
                {t(option.labelKey)}
              </MenuItem>
            </Fragment>
          ))}
          <MenuItem onClick={() => setReportOpen(true)}>
            <ExportFormatIcon Icon={DocxIcon} pending={false} />
            {t("workspaces.views.exportDocxTemplate")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <ExportReportControl
        initialMode="download"
        onOpenChange={setReportOpen}
        open={reportOpen}
        view={view}
        workspaceId={workspaceId}
      />
    </>
  );
};

type RunPlaybookControlProps = {
  workspaceId: string;
};

/**
 * Runs an org playbook over the current table. The top "Auto run" entry
 * auto-detects which playbooks apply to the documents present in the matter and
 * materializes them all at once; each individual entry materializes a single
 * playbook's ASK + verdict columns and starts extraction. New columns appear
 * once the properties query refreshes.
 */
const RunPlaybookControl = ({ workspaceId }: RunPlaybookControlProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [open, setOpen] = useState(false);
  const [runningPlaybookId, setRunningPlaybookId] = useState<string | null>(
    null,
  );
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  // Where a run's results land. Sent explicitly on every request: the endpoint
  // takes a named projection, and the client never leaves the choice to a
  // server-side default.
  const [projection, setProjection] =
    useState<PlaybookRunProjection>("columns");

  // Deferred until the menu opens: the org playbook list isn't needed to render
  // the toolbar, and useQuery (not useSuspenseQuery) keeps a cache miss from
  // suspending the toolbar chrome.
  const {
    data: playbooksData,
    isLoading,
    isError,
  } = useQuery({
    ...playbooksOptions(activeOrganizationId, PLAYBOOK_PICKER_LIMIT),
    enabled: open,
  });
  const playbooks =
    playbooksData && "items" in playbooksData ? playbooksData.items : [];

  // Sends one run request and reports its failure. `onSettled` runs as soon
  // as the request does, before any toast; on success the menu closes and the
  // workspace's properties refetch before the started run is returned.
  const requestRun = async <Data,>(
    request: () => Promise<{
      data: Data | null;
      error: ToAPIErrorProps | null;
    }>,
    onSettled: () => void,
  ): Promise<Data | null> => {
    const result = await Result.tryPromise(request);
    onSettled();

    const reportFailure = (error: unknown, description: string) => {
      notifyUserError(error, t("workspaces.playbooks.runFailed"), {
        description,
      });
    };
    if (Result.isError(result)) {
      analytics.captureError(result.error);
      reportFailure(result.error, t("common.unexpectedError"));
      return null;
    }

    const response = result.value;
    if (response.error) {
      analytics.captureError(toAPIError(response.error));
      reportFailure(
        toAPIError(response.error),
        userErrorMessage(response.error, t("common.unexpectedError")),
      );
      return null;
    }
    if (response.data === null) {
      reportFailure(undefined, t("common.unexpectedError"));
      return null;
    }

    setOpen(false);
    await queryClient.invalidateQueries({
      queryKey: propertiesKeys.all(workspaceId),
    });
    return response.data;
  };

  const handleAutoRun = async () => {
    setIsAutoRunning(true);
    const started = await requestRun(
      async () => {
        const { data, error } = await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .playbooks["auto-run"].post({});
        return { data, error };
      },
      () => setIsAutoRunning(false),
    );
    if (started === null) {
      return;
    }
    stellaToast.add({
      type: "success",
      title: t("workspaces.playbooks.autoRunStarted", {
        count: started.playbooksRun,
      }),
    });
  };

  const handleRun = async (playbookId: string) => {
    setRunningPlaybookId(playbookId);
    const started = await requestRun(
      async () => {
        const { data, error } = await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
          .run.post({ projection });
        return { data, error };
      },
      () => setRunningPlaybookId(null),
    );
    if (started === null) {
      return;
    }
    stellaToast.add({
      type: "success",
      title:
        projection === "none"
          ? t("workspaces.playbooks.reviewStarted", {
              count: started.documentRunCount,
            })
          : t("workspaces.playbooks.runStarted", {
              count: started.runPropertyCount,
            }),
    });
  };

  const isRunning = runningPlaybookId !== null || isAutoRunning;

  return (
    <Menu onOpenChange={setOpen} open={open}>
      <CapabilityAction action={{ capability: "ai" }} surface="control">
        {(capabilityProps) => (
          <MenuTrigger
            render={
              <Button
                aria-label={t("workspaces.playbooks.run")}
                disabled={isRunning}
                size="icon-xs"
                title={t("workspaces.playbooks.run")}
                variant="ghost"
              />
            }
            {...capabilityProps}
          >
            <PlayIcon className="size-3.5" />
          </MenuTrigger>
        )}
      </CapabilityAction>
      <MenuPopup>
        <CapabilityAction action={{ capability: "ai" }} surface="menu">
          {(capabilityProps) => (
            <MenuItem
              closeOnClick={false}
              disabled={isRunning}
              onClick={() => {
                detached(handleAutoRun(), "view-toolbar.auto-run");
              }}
              {...capabilityProps}
            >
              <AiActionIcon className="size-3.5" />
              <span className="flex flex-col">
                <span>{t("workspaces.playbooks.autoRun")}</span>
                <span className="text-muted-foreground text-xs">
                  {t("workspaces.playbooks.autoRunHint")}
                </span>
              </span>
            </MenuItem>
          )}
        </CapabilityAction>
        <MenuSeparator />
        {/* Applies to the individual playbooks below; auto-run always
            materializes columns. */}
        <MenuGroup>
          <MenuGroupLabel>
            {t("workspaces.playbooks.projection")}
          </MenuGroupLabel>
          <MenuRadioGroup
            onValueChange={(value) => {
              setProjection(value === "none" ? "none" : "columns");
            }}
            value={projection}
          >
            <MenuRadioItem closeOnClick={false} value="columns">
              {t("workspaces.playbooks.projectionColumns")}
            </MenuRadioItem>
            <MenuRadioItem closeOnClick={false} value="none">
              {t("workspaces.playbooks.projectionNone")}
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        {isLoading && (
          <MenuItem disabled>{t("knowledge.playbooks.loading")}</MenuItem>
        )}
        {isError && (
          <MenuItem disabled>{t("knowledge.playbooks.loadFailed")}</MenuItem>
        )}
        {!isLoading && !isError && playbooks.length === 0 && (
          <MenuItem disabled>{t("knowledge.playbooks.empty")}</MenuItem>
        )}
        {playbooks.map((playbook) => (
          <CapabilityAction
            action={{ capability: "ai" }}
            surface="menu"
            key={playbook.id}
          >
            {(capabilityProps) => (
              <MenuItem
                closeOnClick={false}
                disabled={isRunning}
                onClick={() => {
                  detached(handleRun(playbook.id), "view-toolbar.run");
                }}
                {...capabilityProps}
              >
                {playbook.name}
              </MenuItem>
            )}
          </CapabilityAction>
        ))}
      </MenuPopup>
    </Menu>
  );
};

type FilesystemOrganizerActionProps = {
  workspaceId: string;
};

const FilesystemOrganizerAction = ({
  workspaceId,
}: FilesystemOrganizerActionProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const selectedIds = useWorkspaceStore((state) => state.filesystemSelectedIds);

  // Folders and files are fetched across all paginated organizer pages,
  // independent of the FilesystemView's current page. useQuery (not
  // useSuspenseQuery) keeps a cache miss from suspending the toolbar
  // chrome — the action button just stays disabled until the data resolves.
  const foldersDataQuery = useQuery(workspaceFoldersOptions(workspaceId));
  const foldersDataView = useQueryView(foldersDataQuery);
  const foldersData =
    foldersDataView.type === "items" ? foldersDataView.items : undefined;
  const allFolders = normalizeOptionalArray(foldersData);
  const filesDataQuery = useQuery(workspaceFilesOptions(workspaceId));
  const filesDataView = useQueryView(filesDataQuery);
  const filesData =
    filesDataView.type === "items" ? filesDataView.items : undefined;
  const allFiles = normalizeOptionalArray(filesData);

  const existingFolders = (() => {
    const folderById = new Map(
      allFolders.map((folder) => [folder.entityId, folder]),
    );
    // The visited set guards against malformed parent chains
    // (folder A → folder B → folder A) that would otherwise blow the
    // stack. A well-formed DB can't produce cycles, but the data we
    // see here comes from a client cache and is worth defending.
    const resolvePath = (folderId: string, visited: Set<string>): string => {
      if (visited.has(folderId)) {
        return "";
      }
      visited.add(folderId);
      const folder = folderById.get(folderId);
      if (!folder) {
        return "";
      }
      if (!folder.parentId) {
        return folder.name;
      }
      const parentPath = resolvePath(folder.parentId, visited);
      return parentPath ? `${parentPath}/${folder.name}` : folder.name;
    };

    return allFolders.map((folder) => ({
      entityId: folder.entityId,
      name: folder.name,
      path: resolvePath(folder.entityId, new Set()),
      parentId: folder.parentId,
    }));
  })();
  const selectedFiles = allFiles.filter((file) =>
    selectedIds.has(file.entityId),
  );
  // Fall back to all files when the persisted selection no longer
  // matches anything in the workspace; otherwise the organizer would
  // be unusably empty after the user navigates away from the folder
  // where the selection was made.
  const organizerSourceFiles =
    selectedFiles.length > 0 ? selectedFiles : allFiles;
  const organizerFiles = organizerSourceFiles.map((file) => ({
    entityId: file.entityId,
    originalName: file.fileName,
    parentId: file.parentId,
    mimeType: file.mimeType,
  }));

  return (
    <>
      <QueryViewFeedback view={foldersDataView} />
      <QueryViewFeedback view={filesDataView} />
      <Button
        aria-label={
          selectedFiles.length > 0
            ? t("workspaces.importOrganizer.actionSelected", {
                count: organizerFiles.length,
              })
            : t("workspaces.importOrganizer.action")
        }
        disabled={
          organizerFiles.length === 0 ||
          foldersDataView.type === "pending" ||
          foldersDataView.type === "error" ||
          filesDataView.type === "pending" ||
          filesDataView.type === "error"
        }
        onClick={() => setOpen(true)}
        size="xs"
        title={
          selectedFiles.length > 0
            ? t("workspaces.importOrganizer.actionSelected", {
                count: organizerFiles.length,
              })
            : t("workspaces.importOrganizer.action")
        }
        type="button"
        variant="outline"
      >
        <Rows3Icon />
        <span className="hidden sm:inline">
          {selectedFiles.length > 0
            ? t("workspaces.importOrganizer.actionSelected", {
                count: organizerFiles.length,
              })
            : t("workspaces.importOrganizer.action")}
        </span>
      </Button>
      <ExistingFileOrganizerDialog
        existingFolders={existingFolders}
        files={organizerFiles}
        onOpenChange={setOpen}
        open={open}
        workspaceId={workspaceId}
      />
    </>
  );
};

const METADATA_COLUMNS = [
  {
    id: getInternalPropertyId("created-by"),
    labelKey: "common.author",
    icon: UserIcon,
  },
  {
    id: getInternalPropertyId("updated-at"),
    labelKey: "common.lastUpdated",
    icon: ClockIcon,
  },
  {
    id: getInternalPropertyId("version"),
    labelKey: "common.version",
    icon: HashIcon,
  },
] as const satisfies readonly {
  id: string;
  labelKey: TranslationKey;
  icon: ComponentType<{ className?: string }>;
}[];

/**
 * A matter's toggleable columns: its metadata, the properties someone fills
 * in, and the ones AI answers.
 *
 * Verdict properties render as a badge inside their ASK column rather than a
 * column of their own, so they are omitted: toggling one would target a
 * column that does not exist. Their visibility follows the ASK column.
 */
const useMatterColumnToggleGroups = (
  properties: WorkspaceProperty[],
): ColumnToggleGroup[] => {
  const t = useTranslations();
  const propertyColumns = (tool: WorkspaceProperty["tool"]["type"]) =>
    properties
      .filter((property) => property.tool.type === tool)
      .map((property) => ({
        id: property.id,
        name: property.name,
        icon: <PropertyIcon type={property.content.type} />,
      }));

  return [
    {
      id: "metadata",
      label: t("common.metadata"),
      columns: METADATA_COLUMNS.map((meta) => ({
        id: meta.id,
        name: t(meta.labelKey),
        icon: <meta.icon className="size-4" />,
      })),
    },
    {
      id: "properties",
      label: t("common.properties"),
      columns: propertyColumns("manual-input"),
    },
    {
      id: "ai",
      label: (
        <>
          <SparklesIcon className="me-1 inline size-3" />
          {t("workspaces.views.aiGenerated")}
        </>
      ),
      columns: propertyColumns("ai-model"),
    },
  ];
};

// -- Calendar controls --

const INTERNAL_DATE_OPTIONS = [
  {
    id: "_created-at",
    labelKey: "workspaces.views.calendar.createdAt",
  },
  {
    id: "_updated-at",
    labelKey: "common.lastUpdated",
  },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

const TASK_DATE_OPTIONS = [
  { id: "_due-date", labelKey: "tasks.dueDate" },
  { id: "_start-date", labelKey: "workspaces.views.timeline.startDate" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

type ResolveDatePropertyLabelArgs = {
  dateProperties: WorkspaceProperty[];
  id: string;
};

type DatePropertyLabel =
  | { type: "custom"; value: string }
  | {
      key:
        | (typeof INTERNAL_DATE_OPTIONS)[number]["labelKey"]
        | (typeof TASK_DATE_OPTIONS)[number]["labelKey"]
        | "workspaces.views.selectProperty";
      type: "translated";
    };

const resolveDatePropertyLabel = ({
  dateProperties,
  id,
}: ResolveDatePropertyLabelArgs): DatePropertyLabel => {
  const internal = INTERNAL_DATE_OPTIONS.find((o) => o.id === id);
  if (internal) {
    return { key: internal.labelKey, type: "translated" };
  }
  const taskDate = TASK_DATE_OPTIONS.find((o) => o.id === id);
  if (taskDate) {
    return { key: taskDate.labelKey, type: "translated" };
  }
  const propertyName = dateProperties.find((p) => p.id === id)?.name;
  if (propertyName) {
    return { type: "custom", value: propertyName };
  }
  return { key: "workspaces.views.selectProperty", type: "translated" };
};

type CalendarDatePropertyControlProps = {
  properties: WorkspaceProperty[];
  datePropertyId: string;
  endDatePropertyId?: string | undefined;
  onChange: (datePropertyId: string, endDatePropertyId?: string) => void;
};

const CalendarDatePropertyControl = ({
  properties,
  datePropertyId,
  endDatePropertyId,
  onChange,
}: CalendarDatePropertyControlProps) => {
  const t = useTranslations();
  const dateProperties = properties.filter((p) => p.content.type === "date");
  const resolvedDatePropertyLabel = resolveDatePropertyLabel({
    dateProperties,
    id: datePropertyId,
  });
  const datePropertyLabel =
    resolvedDatePropertyLabel.type === "translated"
      ? t(resolvedDatePropertyLabel.key)
      : resolvedDatePropertyLabel.value;

  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground shrink-0">
        {t("workspaces.views.calendar.showBy")}
      </span>
      <Select
        onValueChange={(v) => {
          if (v !== null) {
            onChange(v, endDatePropertyId);
          }
        }}
        value={datePropertyId}
      >
        <SelectTrigger className="h-6 min-h-0 min-w-24" size="sm">
          <SelectValue placeholder={datePropertyLabel}>
            {datePropertyLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {TASK_DATE_OPTIONS.map((opt) => (
            <SelectItem key={opt.id} value={opt.id}>
              <CalendarIcon className="size-3.5" />
              {t(opt.labelKey)}
            </SelectItem>
          ))}
          {INTERNAL_DATE_OPTIONS.map((opt) => (
            <SelectItem key={opt.id} value={opt.id}>
              <ClockIcon className="size-3.5" />
              {t(opt.labelKey)}
            </SelectItem>
          ))}
          {dateProperties.map((prop) => (
            <SelectItem key={prop.id} value={prop.id}>
              <CalendarIcon className="size-3.5" />
              {prop.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </span>
  );
};

type AdditionalDatesControlProps = {
  properties: WorkspaceProperty[];
  primaryDatePropertyId: string;
  additionalDatePropertyIds: string[];
  onChange: (ids: string[]) => void;
};

const AdditionalDatesControl = ({
  properties,
  primaryDatePropertyId,
  additionalDatePropertyIds,
  onChange,
}: AdditionalDatesControlProps) => {
  const t = useTranslations();
  const dateProperties = properties.filter((p) => p.content.type === "date");

  // Eligible: internal date options + custom date properties,
  // excluding the primary one (already shown separately)
  const eligible = [
    ...INTERNAL_DATE_OPTIONS.flatMap((o) =>
      o.id !== primaryDatePropertyId ? [{ id: o.id, name: t(o.labelKey) }] : [],
    ),
    ...dateProperties.flatMap((p) =>
      p.id !== primaryDatePropertyId ? [{ id: p.id, name: p.name }] : [],
    ),
  ];

  if (eligible.length === 0) {
    return null;
  }

  const toggleProperty = (id: string) => {
    if (additionalDatePropertyIds.includes(id)) {
      onChange(additionalDatePropertyIds.filter((x) => x !== id));
    } else {
      onChange([...additionalDatePropertyIds, id]);
    }
  };

  const count = additionalDatePropertyIds.length;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost">
            <CalendarIcon className="me-1 size-3" />
            {count > 0
              ? t("workspaces.views.calendar.additionalDates", {
                  count: String(count),
                })
              : t("workspaces.views.calendar.addDates")}
          </Button>
        }
      />
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>
            {t("workspaces.views.calendar.showAdditionalDates")}
          </MenuGroupLabel>
          {eligible.map((item) => {
            const isSelected = additionalDatePropertyIds.includes(item.id);
            return (
              <MenuItem
                key={item.id}
                closeOnClick={false}
                onClick={() => toggleProperty(item.id)}
              >
                <CalendarIcon className="size-3.5" />
                <span className="flex-1">{item.name}</span>
                {isSelected && <span className="text-primary">{"\u2713"}</span>}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
};

type CalendarMode = "month" | "week" | "year";

type CalendarModeControlProps = {
  mode: CalendarMode;
  onChange: (mode: CalendarMode) => void;
};

const CALENDAR_MODES = ["year", "month", "week"] as const;

const calendarModeKeys = {
  year: "workspaces.views.calendar.year",
  month: "workspaces.views.calendar.month",
  week: "workspaces.views.calendar.week",
} as const satisfies Record<CalendarMode, TranslationKey>;

const CalendarModeControl = ({ mode, onChange }: CalendarModeControlProps) => {
  const t = useTranslations();

  return (
    <span className="flex items-center gap-0.5 text-xs">
      {CALENDAR_MODES.map((m) => (
        <Button
          key={m}
          onClick={() => onChange(m)}
          size="xs"
          variant={mode === m ? "secondary" : "ghost"}
        >
          {t(calendarModeKeys[m])}
        </Button>
      ))}
    </span>
  );
};

// -- Timeline controls --

type TimelineDatePropertyControlProps = {
  properties: WorkspaceProperty[];
  startDatePropertyId: string;
  endDatePropertyId: string;
  onChange: (startDatePropertyId: string, endDatePropertyId: string) => void;
};

const TimelineDatePropertyControl = ({
  properties,
  startDatePropertyId,
  endDatePropertyId,
  onChange,
}: TimelineDatePropertyControlProps) => {
  const t = useTranslations();
  const dateProperties = properties.filter((p) => p.content.type === "date");
  const resolvedStartDatePropertyLabel = resolveDatePropertyLabel({
    dateProperties,
    id: startDatePropertyId,
  });
  const startDatePropertyLabel =
    resolvedStartDatePropertyLabel.type === "translated"
      ? t(resolvedStartDatePropertyLabel.key)
      : resolvedStartDatePropertyLabel.value;
  const resolvedEndDatePropertyLabel = resolveDatePropertyLabel({
    dateProperties,
    id: endDatePropertyId,
  });
  const endDatePropertyLabel =
    resolvedEndDatePropertyLabel.type === "translated"
      ? t(resolvedEndDatePropertyLabel.key)
      : resolvedEndDatePropertyLabel.value;

  const dateOptions = (
    <>
      {INTERNAL_DATE_OPTIONS.map((opt) => (
        <SelectItem key={opt.id} value={opt.id}>
          <ClockIcon className="size-3.5" />
          {t(opt.labelKey)}
        </SelectItem>
      ))}
      {dateProperties.map((prop) => (
        <SelectItem key={prop.id} value={prop.id}>
          <CalendarIcon className="size-3.5" />
          {prop.name}
        </SelectItem>
      ))}
    </>
  );

  return (
    <span className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">
        {t("workspaces.views.timeline.startDate")}
      </span>
      <Select
        onValueChange={(v) => {
          if (v !== null) {
            onChange(v, endDatePropertyId);
          }
        }}
        value={startDatePropertyId}
      >
        <SelectTrigger className="h-6 min-h-0 min-w-24" size="sm">
          <SelectValue placeholder={startDatePropertyLabel}>
            {startDatePropertyLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>{dateOptions}</SelectPopup>
      </Select>
      <span className="text-muted-foreground">
        {t("workspaces.views.timeline.endDate")}
      </span>
      <Select
        onValueChange={(v) => {
          if (v !== null) {
            onChange(startDatePropertyId, v);
          }
        }}
        value={endDatePropertyId}
      >
        <SelectTrigger className="h-6 min-h-0 min-w-24" size="sm">
          <SelectValue placeholder={endDatePropertyLabel}>
            {endDatePropertyLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>{dateOptions}</SelectPopup>
      </Select>
    </span>
  );
};

type TimelineZoomControlProps = {
  zoom: "day" | "week" | "month" | "quarter";
  onChange: (zoom: "day" | "week" | "month" | "quarter") => void;
};

const ZOOM_OPTIONS = ["day", "week", "month", "quarter"] as const;

type TimelineZoom = "day" | "week" | "month" | "quarter";

const ZOOM_LABEL_KEYS = {
  day: "workspaces.views.timeline.day",
  week: "workspaces.views.timeline.week",
  month: "workspaces.views.timeline.month",
  quarter: "workspaces.views.timeline.quarter",
} as const satisfies Record<TimelineZoom, TranslationKey>;

const TimelineZoomControl = ({ zoom, onChange }: TimelineZoomControlProps) => {
  const t = useTranslations();

  return (
    <span className="flex items-center gap-0.5 text-xs">
      {ZOOM_OPTIONS.map((z) => (
        <Button
          key={z}
          onClick={() => onChange(z)}
          size="xs"
          variant={zoom === z ? "secondary" : "ghost"}
        >
          {t(ZOOM_LABEL_KEYS[z])}
        </Button>
      ))}
    </span>
  );
};

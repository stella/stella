import type { ComponentType } from "react";
import { Fragment, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  AlignJustifyIcon,
  CalendarIcon,
  Columns3Icon,
  ClockIcon,
  DownloadIcon,
  EyeIcon,
  HashIcon,
  Loader2Icon,
  PlayIcon,
  Rows3Icon,
  Settings2Icon,
  SparklesIcon,
  UserIcon,
  WandSparklesIcon,
  WrapTextIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { PlaybookRunProjection } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
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
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { stellaToast } from "@stll/ui/toast";

import { CsvIcon, DocxIcon, XlsxIcon } from "@/components/document-icon";
import { FolderExpandToggle } from "@/components/file-tree/folder-expand-toggle";
import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/components/workspaces/entity-utils";
import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { resolveDocumentTypeClassifier } from "@/components/workspaces/table/group-columns";
import { useLocale } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { normalizeOptionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { getExportBaseName, getExportFileName } from "@/lib/export-download";
import { fetchWithTimeout } from "@/lib/fetch";
import {
  PLAYBOOK_PICKER_LIMIT,
  playbooksOptions,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import type {
  ViewLayout,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { downloadFile } from "@/lib/utils";
import { isPlaybookVerdictProperty } from "@/lib/workspaces/playbook-verdicts";
import {
  workspaceFilesOptions,
  workspaceFoldersOptions,
} from "@/lib/workspaces/queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/lib/workspaces/queries/properties";
import { useWorkspaceStore } from "@/lib/workspaces/store";
import { mergeLayout } from "@/lib/workspaces/view-layout";
import { BulkAddColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/bulk-add-columns";
import { ExistingFileOrganizerDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog";
import { ExtractionRunProgress } from "@/routes/_protected.workspaces/$workspaceId/-components/extraction-run-progress";
import { isGroupableProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import { ExportReportControl } from "@/routes/_protected.workspaces/$workspaceId/-components/view/export-report-dialog";
import { FilterChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-filters";
import { SortChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-sorts";
import type { TableContentMode } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";

const protectedRouteApi = getRouteApi("/_protected");

type ViewToolbarProps = {
  view: WorkspaceView;
  workspaceId: string;
};

export const ViewToolbar = ({ view, workspaceId }: ViewToolbarProps) => {
  const { data: properties = [] } = useQuery(propertiesOptions(workspaceId));
  const updateView = useUpdateView(workspaceId);
  const { filters, sorts, hiddenProperties } = view.layout;
  const folderState = useWorkspaceStore((s) => s.folderState);
  const toggleAllFolders = useWorkspaceStore((s) => s.toggleAllFolders);
  const selectedEntities = useTableStore((s) => s.selectedEntities[view.id]);

  const handleUpdate = (changes: Partial<ViewLayout>) => {
    updateView.mutate({
      viewId: view.id,
      layout: mergeLayout(view.layout, changes),
    });
  };

  return (
    <div className="flex min-w-0 shrink-0 [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto px-2 py-1 [-ms-overflow-style:none] md:ms-auto md:flex-wrap md:justify-end md:overflow-visible [&::-webkit-scrollbar]:hidden">
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

      <PropertiesToggle
        hiddenProperties={hiddenProperties}
        onChange={(next) => handleUpdate({ hiddenProperties: next })}
        properties={properties}
      />

      {view.layout.type === "kanban" && (
        <>
          <span className="bg-border mx-1 h-4 w-px" />
          <KanbanGroupingSettings
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
          <TableContentModeControl viewId={view.id} />
          <TableExportMenu view={view} workspaceId={workspaceId} />
          <RunPlaybookControl workspaceId={workspaceId} />
          <BulkAddColumns triggerVariant="labelled" workspaceId={workspaceId} />
        </>
      )}

      {view.layout.type === "table" && (
        <SelectionActions
          selectedEntities={selectedEntities}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
};

type SelectionActionsProps = {
  selectedEntities: WorkspaceEntity[] | undefined;
  workspaceId: string;
};

/**
 * Secondary actions for the current row selection (delete, copy/move
 * to matter, download, …). Reuses the row actions menu so the
 * toolbar and the row context menu cannot drift apart.
 */
const SelectionActions = ({
  selectedEntities,
  workspaceId,
}: SelectionActionsProps) => {
  const t = useTranslations();
  const firstSelected = selectedEntities?.at(0);
  if (!firstSelected || selectedEntities === undefined) {
    return null;
  }

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

const TableContentModeControl = ({ viewId }: TableContentModeControlProps) => {
  const t = useTranslations();
  const mode = useTableStore((s) => s.contentMode[viewId] ?? "tight");
  const setMode = useTableStore((s) => s.setContentMode);

  return (
    <SegmentedIconToggle
      onChange={(next) => setMode(viewId, next)}
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
      <Loader2Icon
        aria-hidden={false}
        aria-label={t("common.loading")}
        className="text-muted-foreground size-4.5 animate-spin sm:size-4"
        role="img"
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
      stellaToast.add({
        title: t("workspaces.views.exportFailed"),
        type: "error",
      });
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
            <Loader2Icon className="size-3.5 animate-spin" />
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

  const handleAutoRun = async () => {
    setIsAutoRunning(true);
    const result = await Result.tryPromise(async () => {
      const { data, error } = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .playbooks["auto-run"].post({});
      return { data, error };
    });
    setIsAutoRunning(false);

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("workspaces.playbooks.runFailed"),
        description: t("common.unexpectedError"),
      });
      return;
    }

    const response = result.value;
    if (response.error) {
      analytics.captureError(toAPIError(response.error));
      stellaToast.add({
        type: "error",
        title: t("workspaces.playbooks.runFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
    if (!response.data) {
      stellaToast.add({
        type: "error",
        title: t("workspaces.playbooks.runFailed"),
        description: t("common.unexpectedError"),
      });
      return;
    }

    setOpen(false);
    await queryClient.invalidateQueries({
      queryKey: propertiesKeys.all(workspaceId),
    });
    stellaToast.add({
      type: "success",
      title: t("workspaces.playbooks.autoRunStarted", {
        count: response.data.playbooksRun,
      }),
    });
  };

  const handleRun = async (playbookId: string) => {
    setRunningPlaybookId(playbookId);
    const result = await Result.tryPromise(async () => {
      const { data, error } = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
        .run.post({ projection });
      return { data, error };
    });
    setRunningPlaybookId(null);

    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.add({
        type: "error",
        title: t("workspaces.playbooks.runFailed"),
        description: t("common.unexpectedError"),
      });
      return;
    }

    const response = result.value;
    if (response.error) {
      analytics.captureError(toAPIError(response.error));
      stellaToast.add({
        type: "error",
        title: t("workspaces.playbooks.runFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
    if (!response.data) {
      stellaToast.add({
        type: "error",
        title: t("workspaces.playbooks.runFailed"),
        description: t("common.unexpectedError"),
      });
      return;
    }

    setOpen(false);
    await queryClient.invalidateQueries({
      queryKey: propertiesKeys.all(workspaceId),
    });
    stellaToast.add({
      type: "success",
      title:
        projection === "none"
          ? t("workspaces.playbooks.reviewStarted", {
              count: response.data.documentRunCount,
            })
          : t("workspaces.playbooks.runStarted", {
              count: response.data.runPropertyCount,
            }),
    });
  };

  const isRunning = runningPlaybookId !== null || isAutoRunning;

  return (
    <Menu onOpenChange={setOpen} open={open}>
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
      >
        <PlayIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          closeOnClick={false}
          disabled={isRunning}
          onClick={() => {
            detached(handleAutoRun(), "view-toolbar.auto-run");
          }}
        >
          <WandSparklesIcon className="size-3.5" />
          <span className="flex flex-col">
            <span>{t("workspaces.playbooks.autoRun")}</span>
            <span className="text-muted-foreground text-xs">
              {t("workspaces.playbooks.autoRunHint")}
            </span>
          </span>
        </MenuItem>
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
          <MenuItem
            closeOnClick={false}
            disabled={isRunning}
            key={playbook.id}
            onClick={() => {
              detached(handleRun(playbook.id), "view-toolbar.run");
            }}
          >
            {playbook.name}
          </MenuItem>
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
  const { data: foldersData } = useQuery(workspaceFoldersOptions(workspaceId));
  const allFolders = normalizeOptionalArray(foldersData);
  const { data: filesData } = useQuery(workspaceFilesOptions(workspaceId));
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
      <Button
        aria-label={
          selectedFiles.length > 0
            ? t("workspaces.importOrganizer.actionSelected", {
                count: organizerFiles.length,
              })
            : t("workspaces.importOrganizer.action")
        }
        disabled={organizerFiles.length === 0}
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

const GROUP_BY_NONE_VALUE = "_none";

type GroupByControlProps = {
  properties: WorkspaceProperty[];
  groupByPropertyId: string | undefined;
  onChange: (propertyId: string) => void;
  // When true, an explicit "None" option is offered and an unset
  // grouping resolves to None instead of falling back to a property.
  // Table views default to flat (no grouping); kanban always groups.
  allowNone?: boolean;
  // Multi-select grouping is valid for the table (a row can appear in several
  // sections) but not the kanban board (a card belongs to one column).
  allowMultiSelectGrouping?: boolean;
  allowPersonGrouping?: boolean;
  allowCreatedByGrouping?: boolean;
  excludedPropertyId?: string | undefined;
  label?: string | undefined;
  showLabel?: boolean | undefined;
};

const GroupByControl = ({
  properties,
  groupByPropertyId,
  onChange,
  allowNone = false,
  allowMultiSelectGrouping = false,
  allowPersonGrouping = false,
  allowCreatedByGrouping = false,
  excludedPropertyId,
  label,
  showLabel = true,
}: GroupByControlProps) => {
  const t = useTranslations();
  // The table groups by single- or multi-select (the counts query unnests
  // multi-select arrays); the kanban board stays single-select only.
  const eligible = properties.filter(
    (property) =>
      property.id !== excludedPropertyId &&
      (allowMultiSelectGrouping
        ? isGroupableProperty(property)
        : property.content.type === "single-select" ||
          (allowPersonGrouping && property.content.type === "person")),
  );

  // Grouping by "Document Type" is the primary action — it drives per-type
  // playbook review — so it leads the menu, marked, above the basic groupings.
  // The playbook verdict groupings are collected into their own section below so
  // they don't drown the important choices.
  const documentTypeProp = resolveDocumentTypeClassifier(eligible);
  const verdictProps = eligible.filter((property) =>
    isPlaybookVerdictProperty(property),
  );
  const basicProps = eligible.filter(
    (property) =>
      property !== documentTypeProp && !isPlaybookVerdictProperty(property),
  );

  const resolvedId =
    allowNone && !groupByPropertyId
      ? GROUP_BY_NONE_VALUE
      : resolveKanbanGroupBy(groupByPropertyId ?? "", properties);

  const resolvedLabel = (() => {
    if (resolvedId === GROUP_BY_NONE_VALUE) {
      return t("common.none");
    }
    if (resolvedId === getInternalPropertyId("kind")) {
      return t("common.kind");
    }
    if (resolvedId === getInternalPropertyId("status")) {
      return t("tasks.status");
    }
    if (resolvedId === getInternalPropertyId("created-by")) {
      return t("common.author");
    }
    return (
      eligible.find((p) => p.id === resolvedId)?.name ??
      t("workspaces.views.selectProperty")
    );
  })();

  return (
    <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
      {showLabel && (
        <span className="text-muted-foreground hidden shrink-0 sm:inline">
          {label ?? t("workspaces.views.groupBy")}
        </span>
      )}
      <Select
        onValueChange={(v) => {
          if (v === null) {
            return;
          }
          onChange(v === GROUP_BY_NONE_VALUE ? "" : v);
        }}
        value={resolvedId}
      >
        <SelectTrigger
          className="h-7 min-h-0 w-28 text-xs sm:h-6 sm:w-auto sm:min-w-24"
          size="sm"
        >
          <SelectValue placeholder={resolvedLabel}>{resolvedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {documentTypeProp && (
            <>
              <SelectItem value={documentTypeProp.id}>
                <span className="flex items-center gap-1.5 font-medium">
                  <SparklesIcon className="text-primary size-3.5" />
                  {documentTypeProp.name}
                </span>
              </SelectItem>
              <SelectSeparator />
            </>
          )}
          {allowNone && (
            <SelectItem value={GROUP_BY_NONE_VALUE}>
              {t("common.none")}
            </SelectItem>
          )}
          {excludedPropertyId !== getInternalPropertyId("status") && (
            <SelectItem value={getInternalPropertyId("status")}>
              {t("tasks.status")}
            </SelectItem>
          )}
          {excludedPropertyId !== getInternalPropertyId("kind") && (
            <SelectItem value={getInternalPropertyId("kind")}>
              {t("common.kind")}
            </SelectItem>
          )}
          {allowCreatedByGrouping &&
            excludedPropertyId !== getInternalPropertyId("created-by") && (
              <SelectItem value={getInternalPropertyId("created-by")}>
                {t("common.author")}
              </SelectItem>
            )}
          {basicProps.map((prop) => (
            <SelectItem key={prop.id} value={prop.id}>
              {prop.name}
            </SelectItem>
          ))}
          {verdictProps.length > 0 && (
            <>
              <SelectSeparator />
              {verdictProps.map((prop) => (
                <SelectItem key={prop.id} value={prop.id}>
                  {prop.name}
                </SelectItem>
              ))}
            </>
          )}
        </SelectPopup>
      </Select>
    </span>
  );
};

type KanbanGroupingSettingsProps = {
  groupByPropertyId: string | undefined;
  subgroupByPropertyId: string | undefined;
  onChange: (
    groupByPropertyId: string,
    subgroupByPropertyId: string | undefined,
  ) => void;
  properties: WorkspaceProperty[];
};

const KanbanGroupingSettings = ({
  groupByPropertyId,
  subgroupByPropertyId,
  onChange,
  properties,
}: KanbanGroupingSettingsProps) => {
  const t = useTranslations();
  const resolvedGroupBy = resolveKanbanGroupBy(
    groupByPropertyId ?? "",
    properties,
  );

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("workspaces.views.viewSettings")}
            size="xs"
            type="button"
            variant="outline"
          />
        }
      >
        <Settings2Icon className="size-3.5" />
        <span className="hidden sm:inline">{t("common.settings")}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 p-2" side="bottom">
        <div className="px-2 py-1.5 text-sm font-medium">
          {t("workspaces.views.viewSettings")}
        </div>
        <div className="space-y-1">
          <div className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-lg px-2">
            <Columns3Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-sm">
              {t("workspaces.views.group")}
            </span>
            <GroupByControl
              groupByPropertyId={resolvedGroupBy}
              onChange={(nextGroupBy) =>
                onChange(
                  nextGroupBy,
                  nextGroupBy === subgroupByPropertyId
                    ? undefined
                    : subgroupByPropertyId,
                )
              }
              properties={properties}
              showLabel={false}
            />
          </div>
          <div className="hover:bg-muted/60 flex min-h-11 items-center gap-3 rounded-lg px-2">
            <Rows3Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="min-w-0 flex-1 text-sm">
              {t("workspaces.views.subgroup")}
            </span>
            <GroupByControl
              allowNone
              allowCreatedByGrouping
              allowPersonGrouping
              excludedPropertyId={resolvedGroupBy}
              groupByPropertyId={subgroupByPropertyId}
              onChange={(nextSubgroupBy) =>
                onChange(resolvedGroupBy, nextSubgroupBy || undefined)
              }
              properties={properties}
              showLabel={false}
            />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type PropertiesToggleProps = {
  properties: WorkspaceProperty[];
  hiddenProperties: string[];
  onChange: (hiddenProperties: string[]) => void;
};

const metadataFields = [
  { id: getInternalPropertyId("created-by"), name: "Author", icon: UserIcon },
  {
    id: getInternalPropertyId("updated-at"),
    name: "Last updated",
    icon: ClockIcon,
  },
  { id: getInternalPropertyId("version"), name: "Version", icon: HashIcon },
] as const;

const PropertiesToggle = ({
  properties,
  hiddenProperties,
  onChange,
}: PropertiesToggleProps) => {
  const t = useTranslations();
  const toggleProperty = (propertyId: string) => {
    if (hiddenProperties.includes(propertyId)) {
      const next = hiddenProperties.filter((id) => id !== propertyId);
      onChange(next);
    } else {
      onChange([...hiddenProperties, propertyId]);
    }
  };

  const manualProperties = properties.filter(
    (p) => p.tool.type === "manual-input",
  );
  // Verdict properties render as a badge inside their ASK column rather than a
  // column of their own, so they're omitted here: toggling them would target a
  // column that no longer exists. Their visibility follows the ASK column.
  const aiProperties = properties.filter((p) => p.tool.type === "ai-model");

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("common.columns")}
        render={<Button size="icon-xs" variant="ghost" />}
      >
        <EyeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.metadata")}</MenuGroupLabel>
          {metadataFields.map((meta) => {
            const isVisible = !hiddenProperties.includes(meta.id);
            return (
              <MenuItem
                key={meta.id}
                closeOnClick={false}
                onClick={() => toggleProperty(meta.id)}
              >
                <meta.icon className="size-4" />
                <span className="flex-1">{meta.name}</span>
                {isVisible && <span className="text-primary">{"\u2713"}</span>}
              </MenuItem>
            );
          })}
        </MenuGroup>
        {manualProperties.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("common.properties")}</MenuGroupLabel>
              {manualProperties.map((prop) => {
                const isVisible = !hiddenProperties.includes(prop.id);
                return (
                  <MenuItem
                    closeOnClick={false}
                    key={prop.id}
                    onClick={() => toggleProperty(prop.id)}
                  >
                    <PropertyIcon type={prop.content.type} />
                    <span className="flex-1">{prop.name}</span>
                    {isVisible && (
                      <span className="text-primary">{"\u2713"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
        {aiProperties.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                <SparklesIcon className="me-1 inline size-3" />
                {t("workspaces.views.aiGenerated")}
              </MenuGroupLabel>
              {aiProperties.map((prop) => {
                const isVisible = !hiddenProperties.includes(prop.id);
                return (
                  <MenuItem
                    closeOnClick={false}
                    key={prop.id}
                    onClick={() => toggleProperty(prop.id)}
                  >
                    <PropertyIcon type={prop.content.type} />
                    <span className="flex-1">{prop.name}</span>
                    {isVisible && (
                      <span className="text-primary">{"\u2713"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
};

// -- Calendar controls --

const INTERNAL_DATE_OPTIONS = [
  {
    id: "_created-at",
    labelKey: "workspaces.views.calendar.createdAt",
  },
  {
    id: "_updated-at",
    labelKey: "workspaces.views.calendar.updatedAt",
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
        <SelectTrigger className="h-6 min-h-0 min-w-24 text-xs" size="sm">
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
        <SelectTrigger className="h-6 min-h-0 min-w-24 text-xs" size="sm">
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
        <SelectTrigger className="h-6 min-h-0 min-w-24 text-xs" size="sm">
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

import type { ComponentType } from "react";
import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  AlignJustifyIcon,
  CalendarIcon,
  ClockIcon,
  DownloadIcon,
  EyeIcon,
  HashIcon,
  PlayIcon,
  Rows3Icon,
  SparklesIcon,
  UserIcon,
  WandSparklesIcon,
  WrapTextIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { SegmentedIconToggle } from "@stll/ui/components/segmented-icon-toggle";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { FolderExpandToggle } from "@/components/file-tree/folder-expand-toggle";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import {
  ClientOperationError,
  toAPIError,
  userErrorMessage,
} from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import type {
  ViewLayout,
  WorkspaceEntity,
  WorkspaceProperty,
  WorkspaceView,
} from "@/lib/types";
import { playbooksOptions } from "@/routes/_protected.knowledge/-queries";
import { BulkAddColumns } from "@/routes/_protected.workspaces/$workspaceId/-components/bulk-add-columns";
import { ExistingFileOrganizerDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog";
import { isGroupableProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view.logic";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import { downloadFile } from "@/routes/_protected.workspaces/$workspaceId/-components/utils";
import { FilterChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-filters";
import { SortChips } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar-sorts";
import type { TableContentMode } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useUpdateView } from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import {
  workspaceFilesOptions,
  workspaceFoldersOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

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

  // Generic helper preserves the union discriminant. A bare
  // `{ ...layout, ...partial }` would collapse to an invalid union.
  const mergeLayout = <L extends ViewLayout>(
    layout: L,
    changes: Partial<L>,
  ): L => ({
    ...layout,
    ...changes,
  });
  const handleUpdate = (changes: Partial<ViewLayout>) => {
    updateView.mutate({
      viewId: view.id,
      layout: mergeLayout(view.layout, changes),
    });
  };

  return (
    <div className="flex min-w-0 shrink-0 [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto px-2 py-1 [-ms-overflow-style:none] md:ms-auto md:flex-wrap md:justify-end md:overflow-visible [&::-webkit-scrollbar]:hidden">
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
          <GroupByControl
            groupByPropertyId={view.layout.groupByPropertyId}
            onChange={(groupByPropertyId) =>
              handleUpdate({ groupByPropertyId })
            }
            properties={properties}
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
            additionalDatePropertyIds={
              view.layout.additionalDatePropertyIds ?? []
            }
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
    <div className="ms-auto flex items-center gap-1.5">
      <span className="text-muted-foreground text-xs">
        {t("workspaces.views.fieldsSelected", {
          count: selectedEntities.length,
        })}
      </span>
      <RowActions
        entity={firstSelected}
        selectedEntities={
          selectedEntities.length > 1 ? selectedEntities : undefined
        }
        triggerClassName=""
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

type TableExportFormat = "csv" | "xlsx";

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

  const handleExport = async (format: TableExportFormat) => {
    setExportingFormat(format);
    const result = await Result.tryPromise(async () => {
      const url = new URL(
        apiUrl(`/views/${workspaceId}/view/${view.id}/export`),
      );
      url.searchParams.set("format", format);

      const response = await fetch(url, {
        credentials: "include",
        headers: {
          "Accept-Language": locale,
        },
        signal: AbortSignal.timeout(60_000),
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
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={t("workspaces.views.exportTable")}
            disabled={exportingFormat !== null}
            size="icon-xs"
            title={t("workspaces.views.exportTable")}
            variant="ghost"
          />
        }
      >
        <DownloadIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          disabled={exportingFormat !== null}
          onClick={() => {
            void handleExport("csv");
          }}
        >
          {t("workspaces.views.exportCsv")}
        </MenuItem>
        <MenuItem
          disabled={exportingFormat !== null}
          onClick={() => {
            void handleExport("xlsx");
          }}
        >
          {t("workspaces.views.exportXlsx")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};

const getExportBaseName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) {
    return "table";
  }
  return trimmed.replaceAll(/[/:*?"<>|\\]/gu, "_");
};

const getExportFileName = (
  contentDisposition: string | null,
): string | null => {
  if (!contentDisposition) {
    return null;
  }

  const encodedMatch = /(?:^|;)\s*filename\*=UTF-8''(?<name>[^;]+)/iu.exec(
    contentDisposition,
  );
  const encodedFileName = encodedMatch?.groups?.["name"];
  if (encodedFileName) {
    const decodedResult = Result.try(() => decodeURIComponent(encodedFileName));
    if (!Result.isError(decodedResult)) {
      return decodedResult.value;
    }
  }

  const quotedMatch = /(?:^|;)\s*filename="(?<name>[^"]*)"/iu.exec(
    contentDisposition,
  );
  if (quotedMatch?.groups?.["name"]) {
    return quotedMatch.groups["name"];
  }

  return (
    /(?:^|;)\s*filename=(?<name>[^;]+)/iu.exec(contentDisposition)?.groups?.[
      "name"
    ] ?? null
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

  // Deferred until the menu opens: the org playbook list isn't needed to render
  // the toolbar, and useQuery (not useSuspenseQuery) keeps a cache miss from
  // suspending the toolbar chrome.
  const {
    data: playbooksData,
    isLoading,
    isError,
  } = useQuery({
    ...playbooksOptions(activeOrganizationId),
    enabled: open,
  });
  const playbooks =
    playbooksData && "items" in playbooksData ? playbooksData.items : [];

  const handleAutoRun = async () => {
    setIsAutoRunning(true);
    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .playbooks["auto-run"].post({
        queryKey: propertiesKeys.all(workspaceId),
      });
    setIsAutoRunning(false);

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
    const response = await api
      .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .playbooks({ playbookId: toSafeId<"playbookDefinition">(playbookId) })
      .run.post({ queryKey: propertiesKeys.all(workspaceId) });
    setRunningPlaybookId(null);

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

    setOpen(false);
    await queryClient.invalidateQueries({
      queryKey: propertiesKeys.all(workspaceId),
    });
    stellaToast.add({
      type: "success",
      title: t("workspaces.playbooks.runStarted", {
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
            void handleAutoRun();
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
              void handleRun(playbook.id);
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
  const allFolders = foldersData ?? [];
  const { data: filesData } = useQuery(workspaceFilesOptions(workspaceId));
  const allFiles = filesData ?? [];

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
};

const GroupByControl = ({
  properties,
  groupByPropertyId,
  onChange,
  allowNone = false,
  allowMultiSelectGrouping = false,
}: GroupByControlProps) => {
  const t = useTranslations();
  // The table groups by single- or multi-select (the counts query unnests
  // multi-select arrays); the kanban board stays single-select only.
  const eligible = properties.filter((property) =>
    allowMultiSelectGrouping
      ? isGroupableProperty(property)
      : property.content.type === "single-select",
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
    if (resolvedId === getInternalPropertyId("created-by")) {
      return t("workspaces.filesystem.author");
    }
    return (
      eligible.find((p) => p.id === resolvedId)?.name ??
      t("workspaces.views.selectProperty")
    );
  })();

  return (
    <span className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap">
      <span className="text-muted-foreground hidden shrink-0 sm:inline">
        {t("workspaces.views.groupBy")}
      </span>
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
          {allowNone && (
            <SelectItem value={GROUP_BY_NONE_VALUE}>
              {t("common.none")}
            </SelectItem>
          )}
          <SelectItem value={getInternalPropertyId("kind")}>
            {t("common.kind")}
          </SelectItem>
          {eligible.map((prop) => (
            <SelectItem key={prop.id} value={prop.id}>
              {prop.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </span>
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
                    closeOnClick={false}
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
                    closeOnClick={false}
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
  t: (key: TranslationKey) => string;
};

const resolveDatePropertyLabel = ({
  dateProperties,
  id,
  t,
}: ResolveDatePropertyLabelArgs) => {
  const internal = INTERNAL_DATE_OPTIONS.find((o) => o.id === id);
  if (internal) {
    return t(internal.labelKey);
  }
  const taskDate = TASK_DATE_OPTIONS.find((o) => o.id === id);
  if (taskDate) {
    return t(taskDate.labelKey);
  }
  return (
    dateProperties.find((p) => p.id === id)?.name ??
    t("workspaces.views.selectProperty")
  );
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
  const datePropertyLabel = resolveDatePropertyLabel({
    dateProperties,
    id: datePropertyId,
    t,
  });

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
    ...INTERNAL_DATE_OPTIONS.filter((o) => o.id !== primaryDatePropertyId).map(
      (o) => ({ id: o.id, name: t(o.labelKey) }),
    ),
    ...dateProperties
      .filter((p) => p.id !== primaryDatePropertyId)
      .map((p) => ({ id: p.id, name: p.name })),
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
  const startDatePropertyLabel = resolveDatePropertyLabel({
    dateProperties,
    id: startDatePropertyId,
    t,
  });
  const endDatePropertyLabel = resolveDatePropertyLabel({
    dateProperties,
    id: endDatePropertyId,
    t,
  });

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

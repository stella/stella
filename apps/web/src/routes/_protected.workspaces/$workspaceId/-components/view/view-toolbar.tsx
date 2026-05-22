import type { ComponentType } from "react";
import { useMemo, useState } from "react";

import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import {
  AlignJustifyIcon,
  CalendarIcon,
  ClockIcon,
  DownloadIcon,
  EyeIcon,
  FolderIcon,
  FolderOpenIcon,
  HashIcon,
  Rows3Icon,
  SparklesIcon,
  UserIcon,
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { ClientOperationError } from "@/lib/errors";
import type { ViewLayout, WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { CreateProperty } from "@/routes/_protected.workspaces/$workspaceId/-components/create-property";
import { ExistingFileOrganizerDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/existing-file-organizer-dialog";
import { PropertyIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/property-helpers";
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
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  getInternalPropertyId,
  resolveKanbanGroupBy,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

type ViewToolbarProps = {
  view: WorkspaceView;
  workspaceId: string;
};

export const ViewToolbar = ({ view, workspaceId }: ViewToolbarProps) => {
  const t = useTranslations();
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const updateView = useUpdateView(workspaceId);
  const { filters, sorts, hiddenProperties } = view.layout;
  const folderState = useWorkspaceStore((s) => s.folderState);
  const toggleAllFolders = useWorkspaceStore((s) => s.toggleAllFolders);

  const handleUpdate = (changes: Partial<ViewLayout>) => {
    updateView.mutate({
      viewId: view.id,
      // SAFETY: callers pass subsets matching the current layout
      // discriminant; TS can't verify spread preserves a union.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      layout: { ...view.layout, ...changes } as ViewLayout,
    });
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-1">
      {view.layout.type === "filesystem" && folderState.hasFolders && (
        <>
          <Button
            onClick={toggleAllFolders}
            size="icon-xs"
            title={
              folderState.allExpanded
                ? t("workspaces.filesystem.collapseAll")
                : t("workspaces.filesystem.expandAll")
            }
            variant="ghost"
          >
            {folderState.allExpanded ? (
              <FolderOpenIcon className="size-3.5" />
            ) : (
              <FolderIcon className="size-3.5" />
            )}
          </Button>
          <span className="bg-border mx-1 h-4 w-px" />
        </>
      )}

      <FilterChips
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
          <KanbanGroupByControl
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
          <TableContentModeControl viewId={view.id} />
          <TableExportMenu view={view} workspaceId={workspaceId} />
          <CreateProperty triggerVariant="labelled" workspaceId={workspaceId} />
        </>
      )}
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
    <div className="border-border/70 bg-muted/30 inline-flex h-7 shrink-0 items-center overflow-hidden rounded-md border p-0.5">
      {TABLE_CONTENT_MODE_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isActive = mode === option.mode;
        return (
          <Tooltip
            content={t(option.labelKey)}
            key={option.mode}
            render={
              <Button
                aria-label={t(option.labelKey)}
                aria-pressed={isActive}
                className={cn(
                  "text-muted-foreground h-6 min-h-0 w-7 rounded-[4px] p-0",
                  isActive &&
                    "bg-muted text-foreground ring-border/80 hover:bg-muted hover:text-foreground shadow-xs ring-1",
                )}
                onClick={() => setMode(viewId, option.mode)}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <Icon className="size-3.5" />
          </Tooltip>
        );
      })}
    </div>
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

  const encodedMatch = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/iu.exec(
    contentDisposition,
  );
  const encodedFileName = encodedMatch?.[1];
  if (encodedFileName) {
    const decodedResult = Result.try(() => decodeURIComponent(encodedFileName));
    if (!Result.isError(decodedResult)) {
      return decodedResult.value;
    }
  }

  const quotedMatch = /(?:^|;)\s*filename="([^"]*)"/iu.exec(contentDisposition);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  return /(?:^|;)\s*filename=([^;]+)/iu.exec(contentDisposition)?.[1] ?? null;
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
  const allFolders = useMemo(() => foldersData ?? [], [foldersData]);
  const { data: filesData } = useQuery(workspaceFilesOptions(workspaceId));
  const allFiles = useMemo(() => filesData ?? [], [filesData]);

  const existingFolders = useMemo(() => {
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
  }, [allFolders]);
  const selectedFiles = useMemo(
    () => allFiles.filter((file) => selectedIds.has(file.entityId)),
    [allFiles, selectedIds],
  );
  // Fall back to all files when the persisted selection no longer
  // matches anything in the workspace; otherwise the organizer would
  // be unusably empty after the user navigates away from the folder
  // where the selection was made.
  const organizerSourceFiles = useMemo(
    () => (selectedFiles.length > 0 ? selectedFiles : allFiles),
    [allFiles, selectedFiles],
  );
  const organizerFiles = useMemo(
    () =>
      organizerSourceFiles.map((file) => ({
        entityId: file.entityId,
        originalName: file.fileName,
        parentId: file.parentId,
        mimeType: file.mimeType,
      })),
    [organizerSourceFiles],
  );

  return (
    <>
      <Button
        disabled={organizerFiles.length === 0}
        onClick={() => setOpen(true)}
        size="xs"
        type="button"
        variant="outline"
      >
        <Rows3Icon />
        {selectedFiles.length > 0
          ? t("workspaces.importOrganizer.actionSelected", {
              count: organizerFiles.length,
            })
          : t("workspaces.importOrganizer.action")}
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

type KanbanGroupByControlProps = {
  properties: WorkspaceProperty[];
  groupByPropertyId: string | undefined;
  onChange: (propertyId: string) => void;
};

const KanbanGroupByControl = ({
  properties,
  groupByPropertyId,
  onChange,
}: KanbanGroupByControlProps) => {
  const t = useTranslations();
  const eligible = properties.filter((p) => p.content.type === "single-select");

  const resolvedId = resolveKanbanGroupBy(groupByPropertyId ?? "", properties);

  const resolvedLabel = (() => {
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
      <span className="text-muted-foreground shrink-0">
        {t("workspaces.views.groupBy")}
      </span>
      <Select
        onValueChange={(v) => {
          if (v !== null) {
            onChange(v);
          }
        }}
        value={resolvedId}
      >
        <SelectTrigger className="h-6 min-h-0 min-w-24 text-xs" size="sm">
          <SelectValue placeholder={resolvedLabel}>{resolvedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={getInternalPropertyId("kind")}>
            {t("common.kind")}
          </SelectItem>
          <SelectItem value={getInternalPropertyId("created-by")}>
            {t("workspaces.filesystem.author")}
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
  // TODO: waiting for Damian — version is hardcoded to 1
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
  const aiProperties = properties.filter((p) => p.tool.type === "ai-model");

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost" />}>
        <EyeIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.metadata")}</MenuGroupLabel>
          {metadataFields.map((meta) => {
            const isVisible = !hiddenProperties.includes(meta.id);
            return (
              <MenuItem key={meta.id} onClick={() => toggleProperty(meta.id)}>
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

  const resolveLabel = (id: string) => {
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
          <SelectValue placeholder={resolveLabel(datePropertyId)}>
            {resolveLabel(datePropertyId)}
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
              <MenuItem key={item.id} onClick={() => toggleProperty(item.id)}>
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

  const resolveLabel = (id: string) => {
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
          <SelectValue placeholder={resolveLabel(startDatePropertyId)}>
            {resolveLabel(startDatePropertyId)}
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
          <SelectValue placeholder={resolveLabel(endDatePropertyId)}>
            {resolveLabel(endDatePropertyId)}
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

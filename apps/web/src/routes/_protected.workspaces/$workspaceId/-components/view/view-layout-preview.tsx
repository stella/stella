import {
  BookmarkIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  KanbanIcon,
  TableIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { TranslationKey } from "@/i18n/types";
import { DOCX_MIME } from "@/lib/consts";
import type { ViewLayoutType, WorkspaceEntity } from "@/lib/types";
import {
  CalendarEntityChip,
  TASK_STATUS_DOT_COLORS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-entity-chip";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import { KanbanCard } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-card";
import type {
  TaskPriority,
  TaskStatus,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import {
  STATUS_COLORS,
  STATUS_ICONS,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import type { CalendarTask } from "@/routes/_protected.workspaces/$workspaceId/-queries/calendar-tasks";

import "./view-layout-preview.css";

export type ViewLayoutPreviewKind = ViewLayoutType | "template";

const STATUS_LABEL_KEYS = {
  open: "tasks.statusValues.open",
  in_progress: "tasks.statusValues.in_progress",
  done: "tasks.statusValues.done",
} as const satisfies Partial<Record<TaskStatus, TranslationKey>>;

// Mock content depicting user data, not interface text; deliberately
// untranslated to keep the preview free of per-language i18n debt.
const SAMPLE_NAMES = {
  draft: "Draft pleading",
  review: "Review contract",
  contract: "Service agreement",
  folder: "Pleadings",
  evidence: "Evidence",
} as const;

type ViewLayoutPreviewProps = {
  kind: ViewLayoutPreviewKind | null;
  workspaceId: string;
};

export const ViewLayoutPreview = ({
  kind,
  workspaceId,
}: ViewLayoutPreviewProps) => (
  <div className="pointer-events-none w-64 p-2 select-none">
    <div
      aria-hidden
      className="bg-muted/40 h-36 overflow-hidden rounded-md border p-2"
    >
      {kind && <PreviewCanvas kind={kind} workspaceId={workspaceId} />}
    </div>
  </div>
);

type PreviewCanvasProps = {
  kind: ViewLayoutPreviewKind;
  workspaceId: string;
};

const PreviewCanvas = ({ kind, workspaceId }: PreviewCanvasProps) => {
  if (kind === "kanban") {
    return <KanbanPreview workspaceId={workspaceId} />;
  }
  if (kind === "calendar") {
    return <CalendarPreview workspaceId={workspaceId} />;
  }
  if (kind === "table") {
    return <TablePreview />;
  }
  if (kind === "filesystem") {
    return <ListPreview />;
  }
  if (kind === "overview") {
    return <OverviewPreview />;
  }
  if (kind === "template") {
    return <TemplatePreview />;
  }
  return <TimelinePreview />;
};

const KanbanPreview = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();
  const staying = mockTask({
    entityId: "preview-kanban-staying",
    name: SAMPLE_NAMES.draft,
    status: "in_progress",
    priority: "high",
  });
  const movingInProgress = mockTask({
    entityId: "preview-kanban-moving",
    name: SAMPLE_NAMES.review,
    status: "in_progress",
  });
  const movingDone = mockTask({
    entityId: "preview-kanban-moved",
    name: SAMPLE_NAMES.review,
    status: "done",
  });

  return (
    <div className="h-[150%] w-[150%] origin-top-left scale-[0.667]">
      <div className="flex h-full gap-2">
        <PreviewKanbanColumn
          label={t(STATUS_LABEL_KEYS.in_progress)}
          status="in_progress"
        >
          <KanbanCard entity={staying} workspaceId={workspaceId} />
          <div className="view-layout-preview-move relative">
            <div className="view-layout-preview-fade-out">
              <KanbanCard entity={movingInProgress} workspaceId={workspaceId} />
            </div>
            <div className="view-layout-preview-fade-in absolute inset-0">
              <KanbanCard entity={movingDone} workspaceId={workspaceId} />
            </div>
          </div>
        </PreviewKanbanColumn>
        <PreviewKanbanColumn label={t(STATUS_LABEL_KEYS.done)} status="done" />
      </div>
    </div>
  );
};

type PreviewKanbanColumnProps = React.PropsWithChildren<{
  label: string;
  status: TaskStatus;
}>;

const PreviewKanbanColumn = ({
  label,
  status,
  children,
}: PreviewKanbanColumnProps) => (
  <div className="bg-muted/50 flex min-w-0 flex-1 flex-col gap-1.5 rounded-md p-1.5">
    <span className="flex items-center gap-1.5 px-1 text-xs font-medium">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: TASK_STATUS_DOT_COLORS[status] }}
      />
      <span className="truncate">{label}</span>
    </span>
    {children}
  </div>
);

const CalendarPreview = ({ workspaceId }: { workspaceId: string }) => {
  const days = [6, 7, 8, 9, 10, 13, 14, 15, 16, 17];
  const chips: Record<number, CalendarTask> = {
    7: mockCalendarTask({
      taskId: "preview-calendar-draft",
      name: SAMPLE_NAMES.draft,
      status: "in_progress",
    }),
    15: mockCalendarTask({
      taskId: "preview-calendar-review",
      name: SAMPLE_NAMES.review,
      status: "done",
    }),
  };

  return (
    <div className="h-[133%] w-[133%] origin-top-left scale-75">
      <div className="grid h-full grid-cols-5 grid-rows-2 gap-1">
        {days.map((day) => {
          const chip = chips[day];
          return (
            <div
              className="bg-card flex min-w-0 flex-col gap-0.5 rounded-sm border p-1"
              key={day}
            >
              <span className="text-muted-foreground text-[10px] leading-none">
                {day}
              </span>
              {chip && (
                <CalendarEntityChip
                  entity={chip}
                  isEditable={false}
                  workspaceId={workspaceId}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const TablePreview = () => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col justify-center text-xs">
      <div className="text-muted-foreground grid grid-cols-[1.6fr_1fr] gap-2 border-b px-1 pb-1.5 font-medium">
        <span className="truncate">{t("common.name")}</span>
        <span className="truncate">{t("tasks.status")}</span>
      </div>
      <PreviewTableRow
        icon={
          <EntityKindIcon
            className="size-3.5 shrink-0"
            kind="task"
            status="open"
          />
        }
        name={SAMPLE_NAMES.draft}
        status="open"
      />
      <PreviewTableRow
        icon={
          <EntityKindIcon
            className="size-3.5 shrink-0"
            kind="document"
            mimeType={DOCX_MIME}
          />
        }
        name={SAMPLE_NAMES.contract}
      />
      <PreviewTableRow
        icon={<EntityKindIcon className="size-3.5 shrink-0" kind="folder" />}
        name={SAMPLE_NAMES.folder}
      />
    </div>
  );
};

type PreviewTableRowProps = {
  icon: React.ReactNode;
  name: string;
  status?: TaskStatus;
};

const PreviewTableRow = ({ icon, name, status }: PreviewTableRowProps) => (
  <div className="grid grid-cols-[1.6fr_1fr] items-center gap-2 border-b px-1 py-1.5 last:border-0">
    <span className="flex min-w-0 items-center gap-1.5">
      {icon}
      <span className="truncate">{name}</span>
    </span>
    {status ? (
      <span className="min-w-0">
        <PreviewStatusChip status={status} />
      </span>
    ) : (
      <span className="text-muted-foreground">–</span>
    )}
  </div>
);

const PreviewStatusChip = ({ status }: { status: TaskStatus }) => {
  const t = useTranslations();
  const labelKey =
    status === "open" || status === "in_progress" || status === "done"
      ? STATUS_LABEL_KEYS[status]
      : null;
  if (!labelKey) {
    return null;
  }
  const Icon = STATUS_ICONS[status];

  return (
    <span className="bg-muted/60 text-muted-foreground flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs leading-none">
      <Icon className={`size-3 shrink-0 ${STATUS_COLORS[status]}`} />
      <span className="truncate">{t(labelKey)}</span>
    </span>
  );
};

const ListPreview = () => (
  <div className="flex h-full flex-col justify-center gap-1 text-xs">
    <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 font-medium">
      <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
      <EntityKindIcon className="size-3.5 shrink-0" kind="folder" />
      <span className="truncate">{SAMPLE_NAMES.folder}</span>
    </span>
    <span className="flex min-w-0 items-center gap-1.5 py-0.5 ps-6">
      <EntityKindIcon
        className="size-3.5 shrink-0"
        kind="document"
        mimeType={DOCX_MIME}
      />
      <span className="truncate">{SAMPLE_NAMES.contract}</span>
    </span>
    <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 font-medium">
      <ChevronRightIcon className="text-muted-foreground size-3 shrink-0" />
      <EntityKindIcon className="size-3.5 shrink-0" kind="folder" />
      <span className="truncate">{SAMPLE_NAMES.evidence}</span>
    </span>
  </div>
);

const TemplatePreview = () => (
  <div className="flex h-full flex-col justify-center gap-1.5">
    <div className="bg-card flex items-center gap-1.5 rounded-sm border p-1.5">
      <BookmarkIcon className="text-muted-foreground size-3.5 shrink-0" />
      <div className="bg-muted h-1.5 w-24 rounded-full" />
      <TableIcon className="text-muted-foreground ms-auto size-3.5 shrink-0" />
    </div>
    <div className="bg-card flex items-center gap-1.5 rounded-sm border p-1.5">
      <BookmarkIcon className="text-muted-foreground size-3.5 shrink-0" />
      <div className="bg-muted h-1.5 w-16 rounded-full" />
      <KanbanIcon className="text-muted-foreground ms-auto size-3.5 shrink-0" />
    </div>
    <div className="bg-card flex items-center gap-1.5 rounded-sm border p-1.5">
      <BookmarkIcon className="text-muted-foreground size-3.5 shrink-0" />
      <div className="bg-muted h-1.5 w-20 rounded-full" />
      <CalendarIcon className="text-muted-foreground ms-auto size-3.5 shrink-0" />
    </div>
  </div>
);

const OverviewPreview = () => (
  <div className="flex h-full flex-col gap-1.5">
    <div className="grid flex-1 grid-cols-2 gap-1.5">
      <div className="bg-card flex flex-col justify-between rounded-sm border p-1.5">
        <div className="bg-muted h-1.5 w-10 rounded-full" />
        <div className="bg-muted-foreground/30 h-3 w-7 rounded-sm" />
      </div>
      <div className="bg-card flex flex-col justify-between rounded-sm border p-1.5">
        <div className="bg-muted h-1.5 w-8 rounded-full" />
        <div className="bg-muted-foreground/30 h-3 w-5 rounded-sm" />
      </div>
    </div>
    <div className="bg-card flex flex-1 flex-col justify-evenly rounded-sm border p-1.5">
      <div className="bg-muted h-1.5 w-full rounded-full" />
      <div className="bg-muted h-1.5 w-4/5 rounded-full" />
      <div className="bg-muted h-1.5 w-3/5 rounded-full" />
    </div>
  </div>
);

const TimelinePreview = () => (
  <div className="flex h-full flex-col justify-center gap-2.5 px-1">
    <div className="bg-primary/50 h-2.5 w-1/2 rounded-full" />
    <div className="bg-muted-foreground/30 ms-[30%] h-2.5 w-2/5 rounded-full" />
    <div className="bg-muted-foreground/20 ms-[55%] h-2.5 w-1/3 rounded-full" />
  </div>
);

// Fixed timestamp: previews are static mock data, and Date.now() would make
// the rendered output differ between sessions for no reason.
const PREVIEW_CREATED_AT = "2026-01-15T09:00:00.000Z";

type MockTaskOptions = {
  entityId: string;
  name: string;
  status: TaskStatus;
  priority?: TaskPriority;
};

const mockTask = ({
  entityId,
  name,
  status,
  priority,
}: MockTaskOptions): WorkspaceEntity => ({
  entityId,
  kind: "task",
  name,
  parentId: null,
  createdAt: PREVIEW_CREATED_AT,
  createdBy: null,
  createdByImage: null,
  updatedAt: null,
  version: 1,
  status,
  priority: priority ?? null,
  dueDate: null,
  agendaKind: "task",
  startAt: null,
  endAt: null,
  occurredAt: null,
  remindAt: null,
  allDay: false,
  timeZone: null,
  location: null,
  onlineMeetingUrl: null,
  availability: null,
  sensitivity: null,
  organizer: null,
  attendees: null,
  recurrence: null,
  agendaSource: "manual",
  externalSource: null,
  externalId: null,
  externalChangeKey: null,
  externalICalUid: null,
  readOnly: true,
  sortOrder: null,
  activeEditBy: null,
  fields: {},
  cellMetadata: {},
});

type MockCalendarTaskOptions = {
  taskId: string;
  name: string;
  status: TaskStatus;
};

const mockCalendarTask = ({
  taskId,
  name,
  status,
}: MockCalendarTaskOptions): CalendarTask => ({
  taskId,
  name,
  status,
  createdAt: PREVIEW_CREATED_AT,
  updatedAt: null,
  dueDate: null,
  startAt: null,
  endAt: null,
  occurredAt: null,
  fields: [],
});

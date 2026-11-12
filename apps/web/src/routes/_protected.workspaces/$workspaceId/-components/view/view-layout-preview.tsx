import { useTranslations } from "use-intl";

import {
  AnimatedPreview,
  AnimatedPreviewMotion,
} from "@stll/ui/animated-preview";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  BookmarkIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  KanbanIcon,
  MailIcon,
  TableIcon,
} from "@stll/ui/icons";
import { PreviewPane } from "@stll/ui/preview-pane";
import { cn } from "@stll/ui/utils";

import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { KanbanCard } from "@/components/workspaces/kanban/kanban-card";
import type {
  TaskPriority,
  TaskStatus,
} from "@/components/workspaces/tasks/task-detail-constants";
import {
  STATUS_COLORS,
  STATUS_ICONS,
} from "@/components/workspaces/tasks/task-detail-constants";
import { stateHue } from "@/features/avt/state-chip";
import type { ClaimState } from "@/features/avt/types";
import type { TranslationKey } from "@/i18n/types";
import { DOCX_MIME } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";
import type { ViewLayoutType, WorkspaceEntity } from "@/lib/types";
import type { CalendarTask } from "@/lib/workspaces/queries/calendar-tasks";
import { CalendarEntityChip } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-entity-chip";
import { TASK_STATUS_DOT_COLORS } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-utils";

import "./view-layout-preview.css";
import { TruncatedText } from "@stll/ui/truncated-text";

export type ViewLayoutPreviewKind = ViewLayoutType | "template";

// Only the statuses shown in the mock preview UI (kanban/table columns)
// carry a label; `in_review` and `cancelled` have no preview affordance.
// A total record so a newly added status forces a decision here instead of
// silently rendering blank.
const STATUS_LABEL_KEYS = {
  open: "tasks.statusValues.open",
  in_progress: "tasks.statusValues.in_progress",
  in_review: null,
  done: "tasks.statusValues.done",
  cancelled: null,
} as const satisfies Record<TaskStatus, TranslationKey | null>;

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
  <PreviewPane>
    {kind && <PreviewCanvas kind={kind} workspaceId={workspaceId} />}
  </PreviewPane>
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
  if (kind === "avt") {
    return <AvtPreview />;
  }
  if (kind === "correspondence") {
    return <CorrespondencePreview />;
  }
  return <TimelinePreview />;
};

const KanbanPreview = ({ workspaceId }: { workspaceId: string }) => {
  const t = useTranslations();

  return (
    <div className="h-[150%] w-[150%] origin-top-left scale-[0.667]">
      <div className="flex h-full gap-2">
        <PreviewKanbanColumn
          label={t(STATUS_LABEL_KEYS.in_progress)}
          status="in_progress"
        >
          <KanbanCard entity={KANBAN_STAYING_TASK} workspaceId={workspaceId} />
          <div className="view-layout-preview-kanban-carry">
            <AnimatedPreviewMotion>
              <AnimatedPreview
                stages={[
                  {
                    id: "in-progress",
                    content: (
                      <KanbanCard
                        entity={KANBAN_MOVING_IN_PROGRESS_TASK}
                        workspaceId={workspaceId}
                      />
                    ),
                  },
                  {
                    id: "done",
                    content: (
                      <KanbanCard
                        entity={KANBAN_MOVING_DONE_TASK}
                        workspaceId={workspaceId}
                      />
                    ),
                  },
                ]}
              />
            </AnimatedPreviewMotion>
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
      <TruncatedText>{label}</TruncatedText>
    </span>
    {children}
  </div>
);

const CalendarPreview = ({ workspaceId }: { workspaceId: string }) => (
  <div className="h-[133%] w-[133%] origin-top-left scale-75">
    <div className="grid h-full grid-cols-5 grid-rows-2 gap-1">
      {CALENDAR_DAYS.map((day) => {
        const chip = CALENDAR_CHIPS[day];
        return (
          <div
            className="bg-card flex min-w-0 flex-col gap-0.5 rounded-sm border p-1"
            key={day}
          >
            <span className="text-muted-foreground text-3xs leading-none">
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

const TablePreview = () => {
  const t = useTranslations();

  return (
    <div className="flex h-full flex-col justify-center text-xs">
      <div className="text-muted-foreground grid grid-cols-[1.6fr_1fr] gap-2 border-b px-1 pb-1.5 font-medium">
        <TruncatedText>{t("common.name")}</TruncatedText>
        <TruncatedText>{t("tasks.status")}</TruncatedText>
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
      <TruncatedText>{name}</TruncatedText>
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
  const labelKey = STATUS_LABEL_KEYS[status];
  if (!labelKey) {
    return null;
  }
  const Icon = STATUS_ICONS[status];

  return (
    <span className="bg-muted/60 text-muted-foreground flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs leading-none">
      <Icon className={cn("size-3 shrink-0", STATUS_COLORS[status])} />
      <TruncatedText>{t(labelKey)}</TruncatedText>
    </span>
  );
};

const ListPreview = () => (
  <div className="flex h-full flex-col justify-center gap-1 text-xs">
    <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 font-medium">
      <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
      <EntityKindIcon className="size-3.5 shrink-0" kind="folder" />
      <TruncatedText>{SAMPLE_NAMES.folder}</TruncatedText>
    </span>
    <span className="flex min-w-0 items-center gap-1.5 py-0.5 ps-6">
      <EntityKindIcon
        className="size-3.5 shrink-0"
        kind="document"
        mimeType={DOCX_MIME}
      />
      <TruncatedText>{SAMPLE_NAMES.contract}</TruncatedText>
    </span>
    <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 font-medium">
      <DirectionalIcon
        className="text-muted-foreground size-3 shrink-0"
        icon={ChevronRightIcon}
      />
      <EntityKindIcon className="size-3.5 shrink-0" kind="folder" />
      <TruncatedText>{SAMPLE_NAMES.evidence}</TruncatedText>
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

// A statement's claims (start side) linked to the anchor facts (end side)
// that grade them. Each link draws in on its own beat in its verdict's hue;
// the last claim finds no fact and keeps the dotted no-coverage mark.
const AvtPreview = () => (
  <div className="relative size-full rtl:-scale-x-100">
    <svg className="absolute inset-0 size-full" viewBox={AVT_VIEWBOX}>
      <rect
        className="fill-card stroke-border"
        height={112}
        rx={6}
        width={AVT_CARD_END - 4}
        x={4}
        y={8}
      />
      <rect
        className="fill-muted-foreground/30"
        height={4}
        rx={2}
        width={40}
        x={12}
        y={16}
      />
      {AVT_PREVIEW_CLAIMS.flatMap((claim) =>
        claim.prose.map(([x1, x2]) => (
          <rect
            className="fill-muted"
            height={5}
            key={`${claim.id}:${x1}`}
            rx={2.5}
            width={x2 - x1}
            x={x1}
            y={claim.y - 2.5}
          />
        )),
      )}
      {AVT_PREVIEW_CLAIMS.map((claim) => (
        <rect
          className="fill-muted-foreground/25"
          height={5}
          key={claim.id}
          rx={2.5}
          width={claim.span[1] - claim.span[0]}
          x={claim.span[0]}
          y={claim.y - 2.5}
        />
      ))}
      {AVT_PREVIEW_FACTS.map((fact) => (
        <g key={fact.id}>
          <rect
            className="fill-card stroke-border"
            height={AVT_FACT_HEIGHT}
            rx={5}
            width={236 - AVT_FACT_START}
            x={AVT_FACT_START}
            y={fact.y - AVT_FACT_HEIGHT / 2}
          />
          <rect
            className="fill-muted-foreground/30"
            height={4}
            rx={2}
            width={fact.width}
            x={AVT_FACT_START + 8}
            y={fact.y - 2}
          />
        </g>
      ))}
    </svg>
    {AVT_PREVIEW_CLAIMS.map((claim, index) => (
      <AnimatedPreview
        className="absolute inset-0"
        key={claim.id}
        pace="beat"
        stagger={index * 3}
        stages={[
          { id: "pending", content: null },
          { id: "graded", content: <AvtPreviewLink claim={claim} /> },
        ]}
      />
    ))}
  </div>
);

const AvtPreviewLink = ({ claim }: { claim: AvtPreviewClaim }) => {
  const hue = stateHue(claim.state);
  const [x1, x2] = claim.span;
  const underline = claim.y + 5;
  if (claim.factY === null) {
    return (
      <svg className="size-full" viewBox={AVT_VIEWBOX}>
        <line
          stroke={hue}
          strokeDasharray="1.5 2"
          strokeLinecap="round"
          strokeWidth={1.5}
          x1={x1}
          x2={x2}
          y1={underline}
          y2={underline}
        />
      </svg>
    );
  }
  const bend = (AVT_CARD_END + AVT_FACT_START) / 2;
  return (
    <svg className="size-full" viewBox={AVT_VIEWBOX}>
      <line
        stroke={hue}
        strokeLinecap="round"
        strokeWidth={1.5}
        x1={x1}
        x2={x2}
        y1={underline}
        y2={underline}
      />
      <path
        d={`M ${AVT_CARD_END} ${claim.y} C ${bend} ${claim.y}, ${bend} ${claim.factY}, ${AVT_FACT_START} ${claim.factY}`}
        fill="none"
        stroke={hue}
        strokeWidth={1.5}
      />
      <circle cx={AVT_CARD_END} cy={claim.y} fill={hue} r={2.5} />
      <circle cx={AVT_FACT_START} cy={claim.factY} fill={hue} r={2.5} />
    </svg>
  );
};

// The matter's address above the messages filed to it.
const CorrespondencePreview = () => (
  <div className="flex h-full flex-col justify-center gap-1.5">
    <div className="bg-card flex items-center gap-1.5 rounded-sm border p-1.5">
      <MailIcon className="text-muted-foreground size-3.5 shrink-0" />
      <div className="bg-muted-foreground/30 h-1.5 w-28 rounded-full" />
    </div>
    <div className="bg-card flex flex-col rounded-sm border">
      {CORRESPONDENCE_PREVIEW_ROWS.map((row) => (
        <div
          className="flex items-center gap-2 border-b p-1.5 last:border-0"
          key={row.key}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className={cn("bg-muted h-1.5 rounded-full", row.subject)} />
            <div className="bg-muted/60 h-1 w-1/3 rounded-full" />
          </div>
          <div className="bg-muted h-1 w-6 rounded-full" />
        </div>
      ))}
    </div>
  </div>
);

const CORRESPONDENCE_PREVIEW_ROWS = [
  { key: "c1", subject: "w-3/4" },
  { key: "c2", subject: "w-1/2" },
  { key: "c3", subject: "w-2/3" },
] as const;

// Fixed timestamp: previews are static mock data, and the ambient clock would make
// the rendered output differ between sessions for no reason.
const AVT_VIEWBOX = "0 0 240 128";
const AVT_CARD_END = 124;
const AVT_FACT_START = 168;
const AVT_FACT_HEIGHT = 22;

const AVT_PREVIEW_FACTS = [
  { id: "a", y: 30, width: 44 },
  { id: "b", y: 64, width: 36 },
  { id: "c", y: 98, width: 48 },
] as const;

type AvtPreviewClaim = {
  id: string;
  state: ClaimState;
  y: number;
  /** The claim's words: where its verdict mark is drawn. */
  span: readonly [number, number];
  /** The sentence around the claim. */
  prose: readonly (readonly [number, number])[];
  /** The fact the claim is graded against; null for no coverage. */
  factY: number | null;
};

const AVT_PREVIEW_CLAIMS = [
  {
    id: "c1",
    state: "supported",
    y: 34,
    span: [40, 104],
    prose: [[12, 36]],
    factY: AVT_PREVIEW_FACTS[0].y,
  },
  {
    id: "c2",
    state: "contradicted",
    y: 56,
    span: [12, 72],
    prose: [[76, 112]],
    factY: AVT_PREVIEW_FACTS[1].y,
  },
  {
    id: "c3",
    state: "tension",
    y: 78,
    span: [34, 96],
    prose: [[12, 30]],
    factY: AVT_PREVIEW_FACTS[0].y,
  },
  {
    id: "c4",
    state: "nocover",
    y: 100,
    span: [12, 80],
    prose: [[84, 112]],
    factY: null,
  },
] as const satisfies readonly AvtPreviewClaim[];

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
  entityId: toSafeId<"entity">(entityId),
  kind: "task",
  name,
  parentId: null,
  createdAt: PREVIEW_CREATED_AT,
  createdBy: null,
  createdByUserId: null,
  createdByImage: null,
  createdByDeletedAt: null,
  updatedAt: null,
  version: 1,
  currentVersionReference: null,
  status,
  priority: priority ?? null,
  listItemType: "task",
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
  assignees: [],
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

const KANBAN_STAYING_TASK = mockTask({
  entityId: "preview-kanban-staying",
  name: SAMPLE_NAMES.draft,
  status: "in_progress",
  priority: "high",
});

const KANBAN_MOVING_IN_PROGRESS_TASK = mockTask({
  entityId: "preview-kanban-moving",
  name: SAMPLE_NAMES.review,
  status: "in_progress",
});

const KANBAN_MOVING_DONE_TASK = mockTask({
  entityId: "preview-kanban-moved",
  name: SAMPLE_NAMES.review,
  status: "done",
});

const CALENDAR_DAYS = [6, 7, 8, 9, 10, 13, 14, 15, 16, 17];

const CALENDAR_CHIPS: Record<number, CalendarTask> = {
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

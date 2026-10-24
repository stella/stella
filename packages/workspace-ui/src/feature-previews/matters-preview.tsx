import { CalendarIcon, FileTextIcon } from "@stll/ui/icons";
import { KanbanCardShell, KanbanColumnHeader } from "@stll/ui/kanban";
import { MatterIcon } from "@stll/ui/matter-icon";
import { cn } from "@stll/ui/utils";

import { TASK_STATUS_COLORS, TASK_STATUS_ICONS } from "../task-status";
import { formatPreviewCount, formatPreviewDate } from "./format";
import { PREVIEW_MATTERS, PREVIEW_PEOPLE } from "./mock-data";
import type { PreviewMatter, PreviewPerson } from "./mock-data";
import {
  FeaturePreviewSurface,
  PreviewAvatar,
  PreviewAvatarStack,
} from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type MattersPreviewLabels = {
  /** Column names: the task statuses the board groups by. */
  open: string;
  inProgress: string;
  done: string;
};

export type MattersPreviewTaskStatus = "open" | "in_progress" | "done";

export type MattersPreviewTask = {
  name: string;
  status: MattersPreviewTaskStatus;
  /** `YYYY-MM-DD`. */
  due: string;
  assignee: PreviewPerson;
  /** File name of an attached document, if any. */
  attachment: string | null;
};

/** The board's content: the matter in the title row, its team, and the tasks
 *  (grouped into columns by status, in the given order). */
export type MattersPreviewData = {
  matter: PreviewMatter;
  team: readonly PreviewPerson[];
  tasks: readonly MattersPreviewTask[];
};

/** A matter's task board: three status columns of task cards with due dates,
 *  assignees and an attached document. */
export const MattersPreview = ({
  labels,
  locale,
  data = DEFAULT_DATA,
  className,
}: FeaturePreviewProps<MattersPreviewLabels, MattersPreviewData>) => (
  <FeaturePreviewSurface
    className={className}
    icon={<MatterIcon className="size-4 shrink-0" matter={data.matter} />}
    meta={<PreviewAvatarStack people={data.team} />}
    title={data.matter.name}
  >
    <div className="grid h-full grid-cols-3 gap-2 p-2">
      {COLUMNS.map((column) => {
        const tasks = data.tasks.filter(
          (task) => task.status === column.status,
        );
        const Icon = TASK_STATUS_ICONS[column.status];
        return (
          <div
            className="bg-muted/50 flex min-w-0 flex-col gap-1.5 rounded-md pb-1.5"
            key={column.status}
          >
            <KanbanColumnHeader
              className="h-8 px-2"
              meta={formatPreviewCount(locale, tasks.length)}
              swatch={
                <Icon
                  className={cn(
                    "size-3.5 shrink-0",
                    TASK_STATUS_COLORS[column.status],
                  )}
                />
              }
              title={labels[column.label]}
            />
            <div className="flex min-w-0 flex-col gap-1.5 px-1.5">
              {tasks.map((task) => (
                <PreviewTaskCard key={task.name} locale={locale} task={task} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  </FeaturePreviewSurface>
);

type PreviewTaskCardProps = { task: MattersPreviewTask; locale: string };

const PreviewTaskCard = ({ task, locale }: PreviewTaskCardProps) => {
  const Icon = TASK_STATUS_ICONS[task.status];
  return (
    <KanbanCardShell className="p-2.5">
      <div className="flex flex-col gap-2">
        <span className="flex min-w-0 items-start gap-1.5 leading-snug font-medium">
          <Icon
            className={cn(
              "mt-px size-3.5 shrink-0",
              TASK_STATUS_COLORS[task.status],
            )}
          />
          <span className="line-clamp-2 min-w-0">{task.name}</span>
        </span>
        {task.attachment === null ? null : (
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
            <FileTextIcon className="size-3 shrink-0" />
            <span className="truncate">{task.attachment}</span>
          </span>
        )}
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 leading-none">
          <span className="bg-muted/60 flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 whitespace-nowrap tabular-nums">
            <CalendarIcon className="size-3 shrink-0" />
            {formatPreviewDate({
              locale,
              date: task.due,
              options: { day: "numeric", month: "short" },
            })}
          </span>
          <span className="ms-auto">
            <PreviewAvatar person={task.assignee} />
          </span>
        </div>
      </div>
    </KanbanCardShell>
  );
};

const COLUMNS = [
  { status: "open", label: "open" },
  { status: "in_progress", label: "inProgress" },
  { status: "done", label: "done" },
] as const satisfies readonly {
  status: MattersPreviewTaskStatus;
  label: keyof MattersPreviewLabels;
}[];

// The default content; see `mock-data.ts`.
const DEFAULT_DATA = {
  matter: PREVIEW_MATTERS.cargo,
  team: [PREVIEW_PEOPLE.laura, PREVIEW_PEOPLE.tomas, PREVIEW_PEOPLE.amira],
  tasks: [
    {
      name: "Draft statement of claim",
      status: "open",
      due: "2026-10-28",
      assignee: PREVIEW_PEOPLE.laura,
      attachment: null,
    },
    {
      name: "Collect shipping manifests",
      status: "open",
      due: "2026-10-30",
      assignee: PREVIEW_PEOPLE.tomas,
      attachment: null,
    },
    {
      name: "Review expert report on cargo damage",
      status: "in_progress",
      due: "2026-10-21",
      assignee: PREVIEW_PEOPLE.amira,
      attachment: "Expert report – cargo damage.pdf",
    },
    {
      name: "Prepare witness statements",
      status: "in_progress",
      due: "2026-10-23",
      assignee: PREVIEW_PEOPLE.laura,
      attachment: null,
    },
    {
      name: "Send letter before action",
      status: "done",
      due: "2026-10-12",
      assignee: PREVIEW_PEOPLE.tomas,
      attachment: "Letter before action.docx",
    },
    {
      name: "Run conflict check",
      status: "done",
      due: "2026-10-02",
      assignee: PREVIEW_PEOPLE.amira,
      attachment: null,
    },
  ],
} as const satisfies MattersPreviewData;

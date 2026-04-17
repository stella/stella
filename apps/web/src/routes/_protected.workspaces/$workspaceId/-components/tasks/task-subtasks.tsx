import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import { isTaskStatus } from "./task-detail-constants";
import type { TaskStatus } from "./task-detail-constants";

// -- Subtask row --

const SubtaskRow = ({
  name,
  status,
  onToggle,
}: {
  name: string;
  status: TaskStatus | null;
  onToggle: () => void;
}) => {
  const isDone = status === "done";
  return (
    <button
      className="hover:bg-muted/50 flex w-full items-center gap-2 rounded px-1 py-0.5 text-start text-sm"
      onClick={onToggle}
      type="button"
    >
      {isDone ? (
        <CheckCircle2Icon className="size-3.5 text-green-500" />
      ) : (
        <CircleIcon className="text-muted-foreground size-3.5" />
      )}
      <span
        className={cn(
          "truncate",
          isDone && "text-muted-foreground line-through",
        )}
      >
        {name}
      </span>
    </button>
  );
};

// -- Subtasks section --

type Subtask = {
  id: string;
  name: string | null;
  status: string | null;
};

type SubtasksSectionProps = {
  subtasks: Subtask[];
  onToggle: (subtaskId: string, currentStatus: string | null) => void;
};

export const SubtasksSection = ({
  subtasks,
  onToggle,
}: SubtasksSectionProps) => {
  const t = useTranslations("tasks");

  if (subtasks.length === 0) {
    return null;
  }

  return (
    <div className="border-t px-4 py-3">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium">
        {t("subtasks")} ({subtasks.length})
      </h3>
      <div className="space-y-1">
        {subtasks.map((sub) => (
          <SubtaskRow
            key={sub.id}
            name={sub.name ?? t("untitled")}
            onToggle={() => onToggle(sub.id, sub.status)}
            status={isTaskStatus(sub.status) ? sub.status : null}
          />
        ))}
      </div>
    </div>
  );
};

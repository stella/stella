import { Suspense, use, useState, useTransition } from "react";

import { Result } from "better-result";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  View,
} from "react-native";
import { useFormatter, useTimeZone, useTranslations } from "use-intl";

import {
  ENTITY_PRIORITIES,
  isEntityPriority,
  isTaskStatus,
  TASK_STATUS,
  TASK_STATUSES,
} from "@stll/api-contract/entity-options";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { useChanged } from "@/components/changes";
import { ChoiceChip } from "@/components/choice-chip";
import { DueDatePicker } from "@/components/due-date-picker";
import { SectionTitle } from "@/components/matter-team";
import { useCan } from "@/components/role";
import { TaskAssignees } from "@/components/task-assignees";
import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import { epochMilliseconds } from "@/connection/clock";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { CircleCheckIcon, CircleIcon, LinkIcon } from "@/icons.gen";
import type { ApiError } from "@/state/api-request";
import { pickerDate } from "@/state/picked-day";
import {
  chosenDueDate,
  dayAt,
  deleteTask,
  DUE_CHOICES,
  dueChoiceOf,
  isTaskClosed,
  readTask,
  taskLinks,
  updateTask,
} from "@/state/tasks";
import type { TaskChange, TaskDetail } from "@/state/tasks";
import { useAppColors, useUiColors } from "@/theme";

type TaskProps = {
  readonly matterId: string;
  /** The task is gone: its sheet or pane closes. */
  readonly onDeleted: () => void;
  readonly source: AccessTokenSource;
  readonly taskId: string;
};

/**
 * A task as the web's task panel keeps it: its name, status, priority and
 * due date, who works on it, its subtasks and linked items, and deleting
 * it. Each change saves on its own, shows at once and goes back with why if
 * it does not save; the tasks lists load afresh after. A role that cannot
 * edit tasks, or a task synced from an outside calendar, shows read-only.
 */
export const TaskEditor = (props: TaskProps) => {
  const colors = useAppColors();
  const { end } = useSession();
  const { matterId, source, taskId } = props;
  const [load] = useState(async () => {
    const result = await readTask({ fetch, matterId, source, taskId });
    if (Result.isError(result) && result.error._tag === "SignedOutError") {
      end(source);
    }
    return result;
  });

  return (
    <Suspense fallback={<ActivityIndicator color={colors.muted} />}>
      <LoadedTask load={load} {...props} />
    </Suspense>
  );
};

const LoadedTask = ({
  load,
  ...props
}: TaskProps & { readonly load: Promise<Result<TaskDetail, ApiError>> }) => {
  const t = useTranslations("tasks");
  const loaded = use(load);
  if (Result.isError(loaded)) {
    return loaded.error._tag === "SignedOutError" ? null : (
      <Text variant="caption">{t("loadOneFailed")}</Text>
    );
  }
  return <TaskFields task={loaded.value} {...props} />;
};

/** The fields a change can move, as last saved or shown. */
type TaskValues = {
  readonly name: string;
  readonly status: string;
  readonly priority: string;
  readonly dueDate: string | null;
};

const applyChange = (values: TaskValues, change: TaskChange): TaskValues => ({
  ...values,
  [change.type]: change.value,
});

const TaskFields = ({
  matterId,
  onDeleted,
  source,
  task,
  taskId,
}: TaskProps & { readonly task: TaskDetail }) => {
  const t = useTranslations("tasks");
  const matter = useTranslations("matter");
  const { end } = useSession();
  const changed = useChanged();
  const editable = useCan({ entity: ["update"] }) && task.readOnly !== true;
  const deletable = useCan({ entity: ["delete"] }) && task.readOnly !== true;
  const [values, setValues] = useState<TaskValues>({
    name: task.name ?? "",
    status: task.status ?? TASK_STATUS.OPEN,
    priority: task.priority ?? "none",
    dueDate: task.dueDate ?? null,
  });
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();

  /** Shows `change` at once and saves it; one that does not save goes back. */
  const save = (change: TaskChange) => {
    const before = values;
    setValues(applyChange(values, change));
    startSaving(async () => {
      setFailure(null);
      const saved = await updateTask({
        change,
        fetch,
        matterId,
        source,
        taskId,
      });
      if (Result.isOk(saved)) {
        changed("tasks");
        return;
      }
      setValues(before);
      if (saved.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(saved.error));
    });
  };

  const remove = () => {
    Alert.alert(
      t("deleteTitle"),
      t("deleteMessage", {
        name: values.name === "" ? t("untitled") : values.name,
      }),
      [
        { style: "cancel", text: t("cancel") },
        {
          onPress: () => {
            startSaving(async () => {
              setFailure(null);
              const deleted = await deleteTask({
                fetch,
                matterId,
                source,
                taskId,
              });
              if (Result.isOk(deleted)) {
                changed("tasks");
                onDeleted();
                return;
              }
              if (deleted.error._tag === "SignedOutError") {
                end(source);
                return;
              }
              setFailure(writeFailure(deleted.error));
            });
          },
          style: "destructive",
          text: t("delete"),
        },
      ],
    );
  };

  return (
    <View className="gap-5">
      <TaskName
        // A saved or restored name starts the field afresh.
        key={values.name}
        disabled={!editable || saving}
        name={values.name}
        onSave={(name) => {
          save({ type: "name", value: name });
        }}
      />
      {task.readOnly === true ? (
        <Text variant="caption">{t("readOnly")}</Text>
      ) : null}
      <WriteFailureNotice failure={failure} message={t("saveFailed")} />
      <View className="gap-2">
        <SectionTitle title={t("statusTitle")} />
        <View className="flex-row flex-wrap gap-2">
          {TASK_STATUSES.map((status) => (
            <ChoiceChip
              disabled={!editable || saving}
              key={status}
              label={matter(`status.${status}`)}
              onPress={() => {
                if (status !== values.status) {
                  save({ type: "status", value: status });
                }
              }}
              selected={status === values.status}
            />
          ))}
          {/* A status this build does not know shows as it is. */}
          {isTaskStatus(values.status) ? null : (
            <Text variant="caption">{values.status}</Text>
          )}
        </View>
      </View>
      <View className="gap-2">
        <SectionTitle title={t("priorityTitle")} />
        <View className="flex-row flex-wrap gap-2">
          {ENTITY_PRIORITIES.map((priority) => (
            <ChoiceChip
              disabled={!editable || saving}
              key={priority}
              label={t(`priority.${priority}`)}
              onPress={() => {
                if (priority !== values.priority) {
                  save({ type: "priority", value: priority });
                }
              }}
              selected={
                priority ===
                (isEntityPriority(values.priority) ? values.priority : "none")
              }
            />
          ))}
        </View>
      </View>
      <TaskDue
        disabled={!editable || saving}
        dueDate={values.dueDate}
        onChange={(dueDate) => {
          if (dueDate !== values.dueDate) {
            save({ type: "dueDate", value: dueDate });
          }
        }}
      />
      <TaskAssignees
        initial={task.assignees}
        matterId={matterId}
        source={source}
        taskId={taskId}
      />
      <Subtasks
        editable={editable}
        initial={task.children}
        matterId={matterId}
        source={source}
      />
      <LinkedItems task={task} />
      {deletable ? (
        <Button
          disabled={saving}
          onPress={remove}
          variant="destructive-outline"
        >
          {t("delete")}
        </Button>
      ) : null}
    </View>
  );
};

/** The task's name, saved when the field is left; an empty one is undone. */
const TaskName = ({
  disabled,
  name,
  onSave,
}: {
  disabled: boolean;
  name: string;
  onSave: (name: string) => void;
}) => {
  const t = useTranslations("tasks");
  const [typed, setTyped] = useState(name);
  return (
    <Input
      accessibilityLabel={t("name")}
      disabled={disabled}
      multiline
      onChangeText={setTyped}
      onEndEditing={() => {
        const next = typed.trim();
        if (next === "" || next === name) {
          setTyped(name);
          return;
        }
        onSave(next);
      }}
      placeholder={t("untitled")}
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
      value={typed}
    />
  );
};

/**
 * When the task is due: none, a preset from today, or any day from the
 * calendar, as the new task sheet offers them. A choice saves at once.
 */
const TaskDue = ({
  disabled,
  dueDate,
  onChange,
}: {
  disabled: boolean;
  dueDate: string | null;
  onChange: (dueDate: string | null) => void;
}) => {
  const t = useTranslations("tasks");
  const format = useFormatter();
  const timeZone = useTimeZone() ?? "UTC";
  const today = dayAt(epochMilliseconds(), timeZone);
  const shown = dueChoiceOf(dueDate, today);
  // The calendar opens on the task's own day, or tomorrow for an undated one.
  const [picking, setPicking] = useState(false);
  const pickedOn = dueDate ?? today.add({ days: 1 }).toString();

  return (
    <View className="gap-2">
      <SectionTitle title={t("dueTitle")} />
      <View className="flex-row flex-wrap gap-2">
        {DUE_CHOICES.map((choice) => (
          <ChoiceChip
            disabled={disabled}
            key={choice.key}
            label={t(`dueChoice.${choice.key}`)}
            onPress={() => {
              setPicking(false);
              onChange(
                chosenDueDate({ days: choice.days, picked: null }, today),
              );
            }}
            selected={!picking && shown === choice.key}
          />
        ))}
        {Platform.OS === "web" ? null : (
          <ChoiceChip
            disabled={disabled}
            label={
              shown === "pick" && dueDate !== null
                ? format.dateTime(
                    pickerDate(dueDate, { timeZone, plainTime: "12:00" }),
                    {
                      day: "numeric",
                      month: "short",
                      timeZone,
                      weekday: "short",
                    },
                  )
                : t("dueChoice.pick")
            }
            onPress={() => {
              setPicking((open) => !open);
            }}
            selected={picking || shown === "pick"}
          />
        )}
      </View>
      {picking && !disabled ? (
        <DueDatePicker
          day={pickedOn}
          // A task already overdue keeps its day pickable.
          earliest={
            dueDate !== null && dueDate < today.toString()
              ? dueDate
              : today.toString()
          }
          onChange={(day) => {
            setPicking(false);
            onChange(day);
          }}
        />
      ) : null}
    </View>
  );
};

/**
 * The task's subtasks, each ticked done or open again with a tap, as the
 * web's subtask list does. A change shows at once and goes back if it does
 * not save.
 */
const Subtasks = ({
  editable,
  initial,
  matterId,
  source,
}: {
  editable: boolean;
  initial: TaskDetail["children"];
  matterId: string;
  source: AccessTokenSource;
}) => {
  const t = useTranslations("tasks");
  const ui = useUiColors();
  const { end } = useSession();
  const changed = useChanged();
  const [statuses, setStatuses] = useState<ReadonlyMap<string, string>>(
    () =>
      new Map(
        initial.map(({ id, status }) => [id, status ?? TASK_STATUS.OPEN]),
      ),
  );
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [saving, startSaving] = useTransition();
  if (initial.length === 0) {
    return null;
  }

  const toggle = (id: string) => {
    const before = statuses.get(id) ?? TASK_STATUS.OPEN;
    const next = isTaskClosed(before) ? TASK_STATUS.OPEN : TASK_STATUS.DONE;
    const set = (status: string) => {
      setStatuses((current) => new Map(current).set(id, status));
    };
    set(next);
    startSaving(async () => {
      setFailure(null);
      const saved = await updateTask({
        change: { type: "status", value: next },
        fetch,
        matterId,
        source,
        taskId: id,
      });
      if (Result.isOk(saved)) {
        changed("tasks");
        return;
      }
      set(before);
      if (saved.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      setFailure(writeFailure(saved.error));
    });
  };

  return (
    <View className="gap-2">
      <SectionTitle title={t("subtasks")} />
      <View className="border-border bg-card rounded-xl border px-3">
        {initial.map((child, index) => {
          const done = isTaskClosed(statuses.get(child.id) ?? TASK_STATUS.OPEN);
          return (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: done, disabled: !editable }}
              className={`active:bg-accent flex-row items-center gap-3 py-3 ${
                index === 0 ? "" : "border-border border-t"
              }`}
              disabled={!editable || saving}
              key={child.id}
              onPress={() => {
                toggle(child.id);
              }}
            >
              {done ? (
                <CircleCheckIcon color={ui.successForeground} size={18} />
              ) : (
                <CircleIcon color={ui.mutedForeground} size={18} />
              )}
              <Text className="flex-1" numberOfLines={2} variant="rowTitle">
                {child.name === null ||
                child.name === undefined ||
                child.name === ""
                  ? t("untitled")
                  : child.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <WriteFailureNotice failure={failure} message={t("statusFailed")} />
    </View>
  );
};

/** The items the task links to and that link to it, as the web lists them. */
const LinkedItems = ({ task }: { task: TaskDetail }) => {
  const t = useTranslations("tasks");
  const matter = useTranslations("matter");
  const ui = useUiColors();
  const links = taskLinks(task);
  if (links.length === 0) {
    return null;
  }
  return (
    <View className="gap-2">
      <SectionTitle title={t("linked")} />
      <View className="border-border bg-card rounded-xl border px-3">
        {links.map((link, index) => (
          <View
            className={`flex-row items-center gap-3 py-3 ${
              index === 0 ? "" : "border-border border-t"
            }`}
            key={link.id}
          >
            <LinkIcon color={ui.mutedForeground} size={16} />
            <Text className="flex-1" numberOfLines={2} variant="rowTitle">
              {link.name === null || link.name === ""
                ? matter("untitled")
                : link.name}
            </Text>
            {link.kind === "folder" ||
            link.kind === "document" ||
            link.kind === "task" ? (
              <Text variant="caption">{matter(`kind.${link.kind}`)}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
};

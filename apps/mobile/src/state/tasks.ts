import { panic, Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  TASK_CLOSED_STATUSES,
  TASK_STATUS,
} from "@stll/api-contract/entity-options";
import type {
  EntityPriority,
  TaskStatus,
} from "@stll/api-contract/entity-options";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** Tasks across the person's matters, and each matter's own task routes. */
const MY_TASKS_PATH = "/v1/tasks";

/** The most the route returns in one page. */
const MY_TASKS_PAGE_SIZE = 100;

/** Only what the list shows and what opening a task needs. */
const taskSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.nullish(v.string()),
  status: v.nullish(v.string()),
  /** A calendar day, YYYY-MM-DD; absent, the task has no due date. */
  dueDate: v.nullish(v.string()),
  matterId: v.pipe(v.string(), v.minLength(1)),
  matterName: v.string(),
  matterReference: v.nullish(v.string()),
});

const tasksPageSchema = v.object({
  items: v.array(taskSchema),
  nextCursor: v.nullish(v.string()),
});

const createdTaskSchema = v.object({ entityId: v.string() });

export type TaskSummary = v.InferOutput<typeof taskSchema>;

export type TasksPage = {
  readonly items: readonly TaskSummary[];
  /** Where the next page starts; null once the list is whole. */
  readonly nextCursor: string | null;
};

/**
 * A tasks list as far as it has loaded: its pages so far, where the next
 * starts, and why the last one did not load, the whole list's failure when
 * nothing has. `loadedAt` is when its first page came, the day it groups by.
 */
export type TasksLoad = {
  readonly loadedAt: number;
  readonly tasks: readonly TaskSummary[];
  readonly nextCursor: string | null;
  readonly error: ApiError | null;
};

export const NO_TASKS_LOADED: TasksLoad = {
  loadedAt: 0,
  tasks: [],
  nextCursor: null,
  error: null,
};

/** `previous` with the next page appended, or with why it did not load. */
export const applyTasksPage = (
  previous: TasksLoad,
  page: Result<TasksPage, ApiError>,
  at: number,
): TasksLoad => {
  const first = previous.tasks.length === 0;
  if (Result.isError(page)) {
    return {
      ...previous,
      loadedAt: first ? at : previous.loadedAt,
      error: page.error,
    };
  }
  return {
    loadedAt: first ? at : previous.loadedAt,
    tasks: [...previous.tasks, ...page.value.items],
    nextCursor: page.value.nextCursor,
    error: null,
  };
};

/** Whose tasks a list shows, as the web's assignee filter offers. */
export type TaskWhose = "mine" | "everyone" | "unassigned";

/** Which of them: still open, open and past due, or every one. */
export type TaskShow = "open" | "overdue" | "all";

export const TASK_WHOSE: readonly TaskWhose[] = [
  "mine",
  "everyone",
  "unassigned",
];

export const TASK_SHOW: readonly TaskShow[] = ["open", "overdue", "all"];

/** A list of tasks: whose, which, and in one matter or across all of them. */
export type TasksView = {
  readonly whose: TaskWhose;
  readonly show: TaskShow;
  readonly matterId?: string | undefined;
};

const ASSIGNEE_OF = {
  mine: "me",
  everyone: "any",
  unassigned: "unassigned",
} as const satisfies Record<TaskWhose, string>;

/**
 * The task list's query for `view` on `today`: overdue is still open and
 * due before today; a list of every task keeps done and cancelled ones.
 */
export const tasksQuery = (
  view: TasksView,
  today: Temporal.PlainDate,
  cursor: string | null,
): string => {
  const query = new URLSearchParams({
    limit: String(MY_TASKS_PAGE_SIZE),
    assignee: ASSIGNEE_OF[view.whose],
  });
  if (view.matterId !== undefined) {
    query.set("matterId", view.matterId);
  }
  if (view.show === "all") {
    query.set("openOnly", "false");
  }
  if (view.show === "overdue") {
    query.set("dateTo", today.subtract({ days: 1 }).toString());
  }
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  return query.toString();
};

/**
 * One page of the tasks `view` asks for, soonest due first, undated last;
 * `cursor` continues from the page before.
 */
export const listTasks = async ({
  cursor = null,
  fetch,
  source,
  today,
  view,
}: {
  readonly cursor?: string | null;
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly today: Temporal.PlainDate;
  readonly view: TasksView;
}): Promise<Result<TasksPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${MY_TASKS_PATH}?${tasksQuery(view, today, cursor)}`,
        schema: tasksPageSchema,
        source,
      }),
    );
    return Result.ok({
      items: page.items,
      nextCursor: page.nextCursor ?? null,
    });
  });

/**
 * Adds a task to a matter, given to `assigneeIds`: an empty list gives it to
 * nobody. Left out, the server gives it to its creator, so it lists here.
 */
export const createTask = async ({
  assigneeIds,
  dueDate,
  fetch,
  matterId,
  name,
  source,
}: {
  readonly assigneeIds?: readonly string[] | undefined;
  readonly dueDate: string | null;
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly name: string;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const { entityId } = yield* Result.await(
      requestApi({
        body: {
          name,
          ...(dueDate === null ? {} : { dueDate }),
          ...(assigneeIds === undefined ? {} : { assigneeIds }),
        },
        fetch,
        method: "PUT",
        path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}`,
        schema: createdTaskSchema,
        source,
      }),
    );
    return Result.ok(entityId);
  });

/** A person by id and, when the server knows it, by name. */
const personSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.nullish(v.string()),
});

/** An item a task links to, or that links to it. */
const linkedEntitySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.nullish(v.string()),
  kind: v.string(),
});

const taskDetailSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.nullish(v.string()),
  status: v.nullish(v.string()),
  priority: v.nullish(v.string()),
  dueDate: v.nullish(v.string()),
  /** Synced from an outside calendar: the server refuses to change it. */
  readOnly: v.nullish(v.boolean()),
  /** Its subtasks, which the web ticks off from the task. */
  children: v.optional(
    v.array(
      v.object({
        id: v.pipe(v.string(), v.minLength(1)),
        name: v.nullish(v.string()),
        status: v.nullish(v.string()),
      }),
    ),
    [],
  ),
  /** What it links to; an item since deleted is left as null. */
  linksAsSource: v.optional(
    v.array(v.object({ targetEntity: v.nullable(linkedEntitySchema) })),
    [],
  ),
  /** What links to it. */
  linksAsTarget: v.optional(
    v.array(v.object({ sourceEntity: v.nullable(linkedEntitySchema) })),
    [],
  ),
  /** Who works on it; a removed account's row keeps its id. */
  assignees: v.optional(
    v.array(
      v.object({
        userId: v.pipe(v.string(), v.minLength(1)),
        user: v.nullish(personSchema),
      }),
    ),
    [],
  ),
});

export type TaskDetail = v.InferOutput<typeof taskDetailSchema>;

/** One task's status and due date, as its sheet shows them. */
export const readTask = async ({
  fetch,
  matterId,
  source,
  taskId,
}: {
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
  readonly taskId: string;
}): Promise<Result<TaskDetail, ApiError>> =>
  await requestApi({
    fetch,
    path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}/${encodeURIComponent(taskId)}`,
    schema: taskDetailSchema,
    source,
  });

const matterMembersSchema = v.array(
  v.object({
    userId: v.pipe(v.string(), v.minLength(1)),
    user: v.nullish(personSchema),
  }),
);

export type MatterMember = v.InferOutput<typeof matterMembersSchema>[number];

/** The people a matter's tasks can go to: its members. */
export const listMatterMembers = async ({
  fetch,
  matterId,
  source,
}: {
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
}): Promise<Result<MatterMember[], ApiError>> =>
  await requestApi({
    fetch,
    path: `/v1/workspaces/${encodeURIComponent(matterId)}/members`,
    schema: matterMembersSchema,
    source,
  });

/**
 * The people a new task goes to: the chosen ones among the matter's members,
 * in the members' order. A choice left over from another matter, or the
 * creator when they are not a member, goes nowhere.
 */
export const chosenAssignees = (
  chosen: ReadonlySet<string>,
  members: readonly MatterMember[],
): string[] =>
  members
    .filter((member) => chosen.has(member.userId))
    .map((member) => member.userId);

/**
 * Whom a new task goes to, from the members as they loaded: the chosen ones
 * among them, possibly nobody. No matter, or members that did not load,
 * leave it to the server, which gives the task to its creator.
 */
export const newTaskAssignees = (
  chosen: ReadonlySet<string>,
  loaded: Result<MatterMember[], ApiError> | null,
): string[] | undefined =>
  loaded !== null && Result.isOk(loaded)
    ? chosenAssignees(chosen, loaded.value)
    : undefined;

/** Gives a task to one more person, or takes it from them. */
export const setTaskAssignee = async ({
  assigned,
  fetch,
  matterId,
  source,
  taskId,
  userId,
}: {
  readonly assigned: boolean;
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
  readonly taskId: string;
  readonly userId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { taskId, userId },
        fetch,
        method: assigned ? "POST" : "DELETE",
        path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}/assignees`,
        // Only whether it succeeded matters; the sheet already knows who.
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** Moves a task to `status`, such as done, or open again. */
export const setTaskStatus = async ({
  fetch,
  matterId,
  source,
  status,
  taskId,
}: {
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
  readonly status: TaskStatus;
  readonly taskId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { status, taskId },
        fetch,
        method: "PATCH",
        path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}`,
        // Only whether it succeeded matters; the sheet already knows the status.
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/**
 * One change to a task, as the web's task panel makes them: a field at a
 * time. A due date of null takes the date off.
 */
export type TaskChange =
  | { readonly type: "name"; readonly value: string }
  | { readonly type: "status"; readonly value: TaskStatus }
  | { readonly type: "priority"; readonly value: EntityPriority }
  | { readonly type: "dueDate"; readonly value: string | null };

/** The body of the task update for `change`, beside the task's id. */
export const taskChangeBody = (change: TaskChange) => {
  switch (change.type) {
    case "name":
      return { name: change.value };
    case "status":
      return { status: change.value };
    case "priority":
      return { priority: change.value };
    case "dueDate":
      return { dueDate: change.value };
    default:
      change satisfies never;
      return panic(`Unhandled task change: ${String(change)}`);
  }
};

/** Saves one change to a task. */
export const updateTask = async ({
  change,
  fetch,
  matterId,
  source,
  taskId,
}: {
  readonly change: TaskChange;
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
  readonly taskId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        body: { taskId, ...taskChangeBody(change) },
        fetch,
        method: "PATCH",
        path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}`,
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** Deletes a task for good, with its links and assignees. */
export const deleteTask = async ({
  fetch,
  matterId,
  source,
  taskId,
}: {
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
  readonly taskId: string;
}): Promise<Result<void, ApiError>> =>
  await Result.gen(async function* () {
    yield* Result.await(
      requestApi({
        fetch,
        method: "DELETE",
        path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}/${encodeURIComponent(taskId)}`,
        schema: v.unknown(),
        source,
      }),
    );
    return Result.ok(undefined);
  });

/** The items a task links to and that link to it, deleted ones left out. */
export const taskLinks = (
  task: Pick<TaskDetail, "linksAsSource" | "linksAsTarget">,
): {
  readonly id: string;
  readonly name: string | null;
  readonly kind: string;
}[] => {
  const seen = new Set<string>();
  return [
    ...task.linksAsSource.map((link) => link.targetEntity),
    ...task.linksAsTarget.map((link) => link.sourceEntity),
  ].flatMap((entity) => {
    if (entity === null || seen.has(entity.id)) {
      return [];
    }
    seen.add(entity.id);
    return [{ id: entity.id, name: entity.name ?? null, kind: entity.kind }];
  });
};

/** Whether a task in `status` is finished: done or cancelled. */
export const isTaskClosed = (status: string): boolean =>
  TASK_CLOSED_STATUSES.some((closed) => closed === status);

/** The one change a phone makes to a task: done, or open again once finished. */
export const nextTaskStatus = (status: string): TaskStatus =>
  isTaskClosed(status) ? TASK_STATUS.OPEN : TASK_STATUS.DONE;

/**
 * When a task falls due, as the list groups them; a finished task is past
 * falling due.
 */
export type TaskDue =
  "overdue" | "today" | "tomorrow" | "week" | "later" | "none" | "closed";

const DUE_ORDER: readonly TaskDue[] = [
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
  "none",
  "closed",
];

/** The calendar day in `timeZone` at the instant `at`, in epoch milliseconds. */
export const dayAt = (at: number, timeZone: string): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(at)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

/**
 * The due day (YYYY-MM-DD) a new task's choice means: the day picked in the
 * calendar, else a preset number of `days` from `today`, else none.
 */
export const chosenDueDate = (
  { days, picked }: { days: number | null; picked: string | null },
  today: Temporal.PlainDate,
): string | null =>
  picked ?? (days === null ? null : today.add({ days }).toString());

/** The due choices a task offers, as days from today; null leaves it undated. */
export const DUE_CHOICES = [
  { key: "none", days: null },
  { key: "today", days: 0 },
  { key: "tomorrow", days: 1 },
  { key: "nextWeek", days: 7 },
] as const;

/** A preset, or "pick": a day chosen in the calendar. */
export type DueChoice = (typeof DUE_CHOICES)[number]["key"] | "pick";

/**
 * Which choice a task's due date shows as: the preset that gives that day
 * from `today`, else a picked day.
 */
export const dueChoiceOf = (
  dueDate: string | null,
  today: Temporal.PlainDate,
): DueChoice =>
  DUE_CHOICES.find(
    ({ days }) =>
      (days === null ? null : today.add({ days }).toString()) === dueDate,
  )?.key ?? "pick";

/** Where a due date falls from `today`. */
export const dueOf = (
  dueDate: string | null | undefined,
  today: Temporal.PlainDate,
): TaskDue => {
  if (dueDate === null || dueDate === undefined) {
    return "none";
  }
  const days = today.until(Temporal.PlainDate.from(dueDate), {
    largestUnit: "days",
  }).days;
  if (days < 0) {
    return "overdue";
  }
  if (days === 0) {
    return "today";
  }
  if (days === 1) {
    return "tomorrow";
  }
  return days <= 7 ? "week" : "later";
};

/**
 * The tasks under when they fall due, in the server's order within each:
 * overdue first, then today, tomorrow, the coming week, later, undated, and
 * last the finished ones. Empty groups are left out.
 */
export const groupByDue = (
  tasks: readonly TaskSummary[],
  today: Temporal.PlainDate,
): { due: TaskDue; data: TaskSummary[] }[] => {
  const groups = new Map<TaskDue, TaskSummary[]>();
  for (const task of tasks) {
    const due =
      task.status !== null &&
      task.status !== undefined &&
      isTaskClosed(task.status)
        ? "closed"
        : dueOf(task.dueDate, today);
    const group = groups.get(due);
    if (group === undefined) {
      groups.set(due, [task]);
    } else {
      group.push(task);
    }
  }
  return DUE_ORDER.flatMap((due) => {
    const data = groups.get(due);
    return data === undefined ? [] : [{ due, data }];
  });
};

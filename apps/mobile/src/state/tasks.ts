import { Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError, Load } from "@/state/api-request";

/** The person's own open tasks across their matters, soonest due first. */
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

export type TasksLoad = Load<TaskSummary[]>;

/** The open tasks assigned to the person, soonest due first, undated last. */
export const listMyTasks = async ({
  fetch,
  source,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
}): Promise<Result<TaskSummary[], ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        path: `${MY_TASKS_PATH}?limit=${MY_TASKS_PAGE_SIZE}`,
        schema: tasksPageSchema,
        source,
      }),
    );
    return Result.ok(page.items);
  });

/** Adds a task to a matter; the server assigns nothing, so it is the creator's. */
export const createTask = async ({
  dueDate,
  fetch,
  matterId,
  name,
  source,
}: {
  readonly dueDate: string | null;
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly name: string;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const { entityId } = yield* Result.await(
      requestApi({
        body: { name, ...(dueDate === null ? {} : { dueDate }) },
        fetch,
        method: "PUT",
        path: `${MY_TASKS_PATH}/${encodeURIComponent(matterId)}`,
        schema: createdTaskSchema,
        source,
      }),
    );
    return Result.ok(entityId);
  });

/** When a task falls due, as the list groups them. */
export type TaskDue =
  "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

const DUE_ORDER: readonly TaskDue[] = [
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
  "none",
];

/** The calendar day in `timeZone` at the instant `at`, in epoch milliseconds. */
export const dayAt = (at: number, timeZone: string): Temporal.PlainDate =>
  Temporal.Instant.fromEpochMilliseconds(at)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();

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
 * overdue first, then today, tomorrow, the coming week, later, and undated.
 * Empty groups are left out.
 */
export const groupByDue = (
  tasks: readonly TaskSummary[],
  today: Temporal.PlainDate,
): { due: TaskDue; data: TaskSummary[] }[] => {
  const groups = new Map<TaskDue, TaskSummary[]>();
  for (const task of tasks) {
    const due = dueOf(task.dueDate, today);
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

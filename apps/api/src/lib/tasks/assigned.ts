import { panic } from "better-result";
import { and, eq, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { TASK_CLOSED_STATUSES } from "@stll/api-contract/entity-options";

import { entities, taskAssignees } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { entityQueryScopeCondition } from "@/api/lib/entities/query-scope";

/** Whose tasks a list returns: the caller's own assignments, or every task. */
export const TASK_ASSIGNEE_FILTER = {
  ME: "me",
  ANY: "any",
} as const;
export type TaskAssigneeFilter =
  (typeof TASK_ASSIGNEE_FILTER)[keyof typeof TASK_ASSIGNEE_FILTER];
export const TASK_ASSIGNEE_FILTERS = [
  TASK_ASSIGNEE_FILTER.ME,
  TASK_ASSIGNEE_FILTER.ANY,
] as const satisfies readonly TaskAssigneeFilter[];

/** Whose tasks a list keeps, as a condition over `entities`. */
export const taskAssigneeCondition = ({
  assignee,
  userId,
}: {
  assignee: TaskAssigneeFilter;
  userId: SafeId<"user">;
}): SQL | undefined => {
  switch (assignee) {
    case TASK_ASSIGNEE_FILTER.ANY:
      return undefined;
    case TASK_ASSIGNEE_FILTER.ME:
      // Any assignee role counts: a reviewer is as responsible as an assignee.
      return sql`exists (select 1 from ${taskAssignees}
        where ${taskAssignees.entityId} = ${entities.id}
          and ${taskAssignees.workspaceId} = ${entities.workspaceId}
          and ${taskAssignees.userId} = ${userId})`;
    default: {
      assignee satisfies never;
      return panic(`Unhandled assignee filter: ${String(assignee)}`);
    }
  }
};

type DueAssignedTaskConditionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The civil day "due" is measured against, from `resolveWorkAsOf`. */
  asOf: string;
};

/**
 * The caller's tasks that are overdue or due today and not yet finished,
 * across every active matter of the organization they can read (RLS narrows
 * the organization's matters to the caller's membership). Feeds the Inbox
 * badge beside the open-signal count.
 */
export const dueAssignedTaskCondition = ({
  organizationId,
  userId,
  asOf,
}: DueAssignedTaskConditionOptions): SQL =>
  and(
    entityQueryScopeCondition(
      { type: "organization", organizationId },
      entities.workspaceId,
    ),
    eq(entities.kind, "task"),
    lte(entities.dueDate, asOf),
    or(
      isNull(entities.status),
      notInArray(entities.status, [...TASK_CLOSED_STATUSES]),
    ),
    taskAssigneeCondition({ assignee: TASK_ASSIGNEE_FILTER.ME, userId }),
  ) ?? panic("Due-task condition compiled to nothing");

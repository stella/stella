import { panic } from "better-result";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { TASK_CLOSED_STATUSES } from "@stll/api-contract/entity-options";
import { SIGNAL_VIEW } from "@stll/api-contract/signals";
import type { SignalView } from "@stll/api-contract/signals";

import { entities, signals } from "@/api/db/schema";
import { signalListConditions } from "@/api/handlers/signals/read";
import type { SafeId } from "@/api/lib/branded-types";
import type { EntityQueryScope } from "@/api/lib/entities/query-scope";

const isTask = eq(entities.kind, "task");
const isClosedTask =
  and(isTask, inArray(entities.status, [...TASK_CLOSED_STATUSES])) ??
  panic("Closed-task predicate compiled to nothing");

/**
 * The stored rows an Inbox view shows beside its signals. Open keeps every
 * row except finished tasks; resolved is the finished tasks, mirroring
 * resolved (accepted or dismissed) signals; snoozed is signals only, since a
 * task cannot be snoozed.
 */
export const inboxEntityCondition = (view: SignalView): SQL => {
  switch (view) {
    case SIGNAL_VIEW.OPEN:
      return (
        or(
          sql`NOT ${isTask}`,
          isNull(entities.status),
          notInArray(entities.status, [...TASK_CLOSED_STATUSES]),
        ) ?? panic("Open Inbox predicate compiled to nothing")
      );
    case SIGNAL_VIEW.RESOLVED:
      return isClosedTask;
    case SIGNAL_VIEW.SNOOZED:
      return sql`false`;
    default: {
      view satisfies never;
      return panic(`Unhandled Inbox view: ${String(view)}`);
    }
  }
};

type InboxSignalConditionOptions = {
  organizationId: SafeId<"organization">;
  canTriage: boolean;
  view: SignalView;
  now: Date;
  scope: EntityQueryScope;
};

/**
 * The signal list's own access and view predicate, narrowed to the window's
 * matter when it has one. An organization window keeps every signal the list
 * shows, unscoped triage signals included.
 */
export const inboxSignalCondition = ({
  scope,
  ...access
}: InboxSignalConditionOptions): SQL => {
  const listed = signalListConditions(access);
  switch (scope.type) {
    case "organization":
      return listed;
    case "matter":
      return (
        and(listed, eq(signals.workspaceId, scope.workspaceId)) ??
        panic("Matter signal predicate compiled to nothing")
      );
    default: {
      scope satisfies never;
      return panic(`Unhandled window scope: ${String(scope)}`);
    }
  }
};

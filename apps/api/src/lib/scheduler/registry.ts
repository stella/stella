import { createBullMqDispatchTask } from "@/api/lib/scheduler/bullmq";
import {
  RECONCILE_BUFFER_INTENTS_TASK,
  reconcileBufferIntents,
} from "@/api/lib/scheduler/tasks/buffer-intent-reconciliation";
import {
  BACKFILL_SK_DOCUMENTS_TASK,
  backfillSkDocuments,
} from "@/api/lib/scheduler/tasks/case-law-sk-documents";
import {
  EXPIRE_DESKTOP_EDIT_SESSIONS_TASK,
  expireDesktopEditSessions,
} from "@/api/lib/scheduler/tasks/desktop-edit-session-expiry";
import {
  FLOW_RUN_TASK,
  runScheduledFlow,
} from "@/api/lib/scheduler/tasks/flow-run";
import {
  INFO_SOUD_SYNC_TRACKED_CASES_TASK,
  syncInfoSoudTrackedCases,
} from "@/api/lib/scheduler/tasks/infosoud";
import {
  REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK,
  repairSearchSemanticTimestampsTask,
} from "@/api/lib/scheduler/tasks/search-semantic-timestamps";
import type {
  SchedulerTask,
  SchedulerTaskRegistry,
} from "@/api/lib/scheduler/types";

const noopTask: SchedulerTask = ({ logger }) => {
  logger.debug("scheduler.noop");
};

export const createSchedulerTaskRegistry = (): SchedulerTaskRegistry =>
  new Map<string, SchedulerTask>([
    ["scheduler.noop", noopTask],
    ["scheduler.dispatchBullMq", createBullMqDispatchTask()],
    [INFO_SOUD_SYNC_TRACKED_CASES_TASK, syncInfoSoudTrackedCases],
    [EXPIRE_DESKTOP_EDIT_SESSIONS_TASK, expireDesktopEditSessions],
    [FLOW_RUN_TASK, runScheduledFlow],
    [BACKFILL_SK_DOCUMENTS_TASK, backfillSkDocuments],
    [RECONCILE_BUFFER_INTENTS_TASK, reconcileBufferIntents],
    [
      REPAIR_SEARCH_SEMANTIC_TIMESTAMPS_TASK,
      repairSearchSemanticTimestampsTask,
    ],
  ]);

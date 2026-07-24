import { createBullMqDispatchTask } from "@/api/lib/scheduler/bullmq";
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
  MEMORY_CURATOR_TASK,
  curateAiMemories,
} from "@/api/lib/scheduler/tasks/memory-curator";
import {
  MEMORY_EXTRACTOR_TASK,
  extractMemoriesFromCompactions,
} from "@/api/lib/scheduler/tasks/memory-extractor";
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
    [MEMORY_CURATOR_TASK, curateAiMemories],
    [MEMORY_EXTRACTOR_TASK, extractMemoriesFromCompactions],
  ]);

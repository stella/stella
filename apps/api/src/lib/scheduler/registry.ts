import { createBullMqDispatchTask } from "@/api/lib/scheduler/bullmq";
import {
  INFO_SOUD_SYNC_TRACKED_CASES_TASK,
  syncInfoSoudTrackedCases,
} from "@/api/lib/scheduler/tasks/infosoud";
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
  ]);

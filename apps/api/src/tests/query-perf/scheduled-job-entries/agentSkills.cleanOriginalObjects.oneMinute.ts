import { CLEAN_AGENT_SKILL_ORIGINAL_OBJECTS_TASK } from "@/api/lib/scheduler/tasks/agent-skill-original-cleanup";

import { measureAgentSkillOriginalCleanupHistory } from "../agent-skill-original-cleanup-run";
import type { ScheduledJobMeasurement } from "../measurement-definition";

export default {
  task: CLEAN_AGENT_SKILL_ORIGINAL_OBJECTS_TASK,
  scenarios: [],
  measure: measureAgentSkillOriginalCleanupHistory,
} as const satisfies ScheduledJobMeasurement;

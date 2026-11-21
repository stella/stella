export const FLOW_RUN_TASK = "flow.run" as const;

/** Deterministic scheduler-job id so one definition owns at most one row. */
export const flowScheduleJobId = (definitionId: string): string =>
  `flow.run.${definitionId}`;

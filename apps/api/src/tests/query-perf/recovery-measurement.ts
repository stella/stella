import { RECOVERY_SCAN_IDENTITIES } from "@/api/lib/scheduler/tasks/recovery-scan-identity";

export type RecoveryJob = keyof typeof RECOVERY_SCAN_IDENTITIES;
export const RECOVERY_COHORTS = [
  "quiet",
  "pending",
  "grant-repair",
  "ungranted",
] as const;
export type RecoveryCohort = (typeof RECOVERY_COHORTS)[number];
export const RECOVERY_COHORT_SETUP = {
  quiet: { enrolled: true, initialStatus: "pending" },
  pending: { enrolled: false, initialStatus: "pending" },
  "grant-repair": { enrolled: true, initialStatus: "awaiting_grant" },
  ungranted: { enrolled: false, initialStatus: "awaiting_grant" },
} as const satisfies Record<
  RecoveryCohort,
  { enrolled: boolean; initialStatus: "pending" | "awaiting_grant" }
>;
export type RecoveryScenario = {
  type: "recovery";
  job: RecoveryJob;
  cohort: RecoveryCohort;
  rows: number;
};

export const RECOVERY_READ_SIZES = [60_000, 120_000] as const;

/** One registered recovery job, run against every cohort at each read size. */
export const recoveryMeasurement = (job: RecoveryJob) => ({
  type: "recovery" as const,
  task: RECOVERY_SCAN_IDENTITIES[job].task,
  scenarios: RECOVERY_COHORTS.map((cohort) => ({
    type: "recovery" as const,
    job,
    cohort,
  })),
});

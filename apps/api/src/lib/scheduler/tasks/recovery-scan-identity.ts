export const RECOVERY_SCAN_IDENTITIES = {
  upload: {
    task: "flows.recoverUploadTriggers",
    jobId: "flows.recoverUploadTriggers.fiveMinute",
  },
  scout: {
    task: "signals.recoverScoutEmission",
    jobId: "signals.recoverScoutEmission.fiveMinute",
  },
} as const;

export const RECOVERY_SCAN_PAGE_SIZES = {
  census: 1,
  dispatch: 1,
} as const;

export const RECOVERY_SCAN_PHASES = {
  census: "census",
  dispatch: "dispatch",
} as const;

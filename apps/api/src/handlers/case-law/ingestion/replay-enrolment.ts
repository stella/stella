import { panic } from "better-result";

import { defaultConfig, type HealthConfig } from "@stll/db-load-gate/health";

import { readReplayTickEnvironment } from "@/api/env-replay";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

import { MAX_REPLAY_ROW_READMISSIONS } from "./replay-failure";

// A load hold resumes only once the ordinary admission floor is recovered.
export const REPLAY_HEALTH_CONFIG = {
  ...defaultConfig,
  resumeFloor: defaultConfig.startFloor,
} satisfies HealthConfig;

export type ReplayEnrolment =
  | { mode: "off" }
  | { mode: "dry-run"; dailyBudget: number }
  | { mode: "enrolled"; dailyBudget: number; reviewedDryRun: string };

// Enrolment is a reviewed code change, never an environment override.
export const REPLAY_ENROLMENT = {
  [ADAPTER_KEYS.CZ_REGIONAL]: { mode: "off" },
  [ADAPTER_KEYS.CZ_NS]: { mode: "off" },
  [ADAPTER_KEYS.CZ_NSS]: { mode: "off" },
  [ADAPTER_KEYS.CZ_US]: { mode: "off" },
  [ADAPTER_KEYS.SK_COURTS]: { mode: "off" },
  [ADAPTER_KEYS.SK_US]: { mode: "off" },
  [ADAPTER_KEYS.PL_COURTS]: { mode: "off" },
  [ADAPTER_KEYS.PL_SN]: { mode: "off" },
  [ADAPTER_KEYS.PL_KIO]: { mode: "off" },
  [ADAPTER_KEYS.PL_TK]: { mode: "off" },
  [ADAPTER_KEYS.PL_NSA]: { mode: "off" },
  [ADAPTER_KEYS.PL_NCOURT]: { mode: "off" },
  [ADAPTER_KEYS.AT_COURTS]: { mode: "off" },
  [ADAPTER_KEYS.AT_VFGH]: { mode: "off" },
  [ADAPTER_KEYS.AT_VWGH]: { mode: "off" },
  [ADAPTER_KEYS.AT_BVWG]: { mode: "off" },
  [ADAPTER_KEYS.AT_LVWG]: { mode: "off" },
  [ADAPTER_KEYS.AT_ASYLGH]: { mode: "off" },
  [ADAPTER_KEYS.AT_UBAS]: { mode: "off" },
  [ADAPTER_KEYS.AT_UVS]: { mode: "off" },
  [ADAPTER_KEYS.AT_VERG]: { mode: "off" },
  [ADAPTER_KEYS.AT_UMSE]: { mode: "off" },
  [ADAPTER_KEYS.AT_BKS]: { mode: "off" },
  [ADAPTER_KEYS.AT_FINDOK]: { mode: "off" },
  [ADAPTER_KEYS.EU_ECJ]: { mode: "off" },
  [ADAPTER_KEYS.HU_BHGY]: { mode: "off" },
  [ADAPTER_KEYS.PL_KIS]: { mode: "off" },
  [ADAPTER_KEYS.PL_UODO]: { mode: "off" },
  [ADAPTER_KEYS.PL_UOKIK]: { mode: "off" },
} as const satisfies Record<AdapterKey, ReplayEnrolment>;

export const BACKGROUND_REPLAY_LIMITS = {
  maxRows: 100,
  maxDurationMs: 4 * 60_000,
  hardDurationMs: 5 * 60_000,
  maxDailyBudget: 10_000,
  storedRawReadTimeoutMs: 30_000,
  maxRowAttempts: 5,
  maxRowReadmissions: MAX_REPLAY_ROW_READMISSIONS,
  rowReadmissionDelayMs: 7 * 24 * 60 * 60_000,
  rowRetryBaseMs: 60_000,
  rowRetryMaxMs: 60 * 60_000,
  receiptRetentionDays: 90,
  maxCompactRows: 600,
} as const;

export const validateReplayEnrolment = (policy: ReplayEnrolment): void => {
  if (policy.mode === "off") {
    return;
  }
  if (
    !Number.isSafeInteger(policy.dailyBudget) ||
    policy.dailyBudget <= 0 ||
    policy.dailyBudget > BACKGROUND_REPLAY_LIMITS.maxDailyBudget
  ) {
    panic("Replay daily budget must be a positive bounded integer");
  }
  if (policy.mode === "enrolled" && policy.reviewedDryRun.trim().length === 0) {
    panic("Replay enrolment requires a reviewed dry run");
  }
};

// Default stopped. Operators must explicitly enable the scheduled task.
export const replayKillRequested = (adapterKey: AdapterKey) => {
  const environment = readReplayTickEnvironment();
  return (
    !environment.CASE_LAW_REPLAY_ENABLED ||
    environment.CASE_LAW_REPLAY_KILL_SWITCH ||
    environment.CASE_LAW_REPLAY_DISABLED_SOURCES.split(",").some(
      (key) => key.trim() === adapterKey,
    )
  );
};

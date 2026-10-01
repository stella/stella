import { readReplayTickEnvironment } from "@/api/env-base-schema";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

export type ReplayEnrolment =
  | { mode: "off" }
  | { mode: "dry-run"; dailyBudget: number }
  | { mode: "enrolled"; dailyBudget: number; reviewedDryRun: string };

// Enrolment is a reviewed code change, never an environment override.
// The special-case sources cz-ns, sk-us and eu-ecj remain manual.
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
  maxDurationMs: 5 * 60_000,
  maxDailyBudget: 10_000,
  errorRateCeiling: 0.1,
  storedRawReadTimeoutMs: 30_000,
} as const;

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

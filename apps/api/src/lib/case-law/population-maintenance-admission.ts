import { panic, Result } from "better-result";

import type { Signal, Verdict } from "@stll/db-load-gate/health";

import type { IndicatorQuery } from "@/api/db/indicator-query";
import { isRecord } from "@/api/lib/type-guards";

import {
  CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER,
  CASE_LAW_POPULATION_SEED_REPAIR_NAME,
} from "./population-count-limits";

type PopulationMaintenanceAdmissionOptions = {
  query: IndicatorQuery;
  tableName: string;
  tableContention?: "write" | "shared-read" | undefined;
  name?: string;
  clock: () => number;
  verdict: Verdict;
};

/** Maintenance yields to the fold owner; ordinary ingestion never uses this gate. */
export const admitCaseLawPopulationMaintenance = async ({
  query,
  tableName,
  tableContention = "write",
  name,
  clock,
  verdict,
}: PopulationMaintenanceAdmissionOptions): Promise<Verdict> => {
  if (
    tableName !== "case_law_decisions" ||
    tableContention === "shared-read" ||
    name === CASE_LAW_POPULATION_SEED_REPAIR_NAME
  ) {
    return verdict;
  }
  const reading = await Result.tryPromise(async () => {
    const installed = (
      await query(
        "SELECT to_regclass('public.case_law_population_deltas') IS NOT NULL AS installed",
      )
    ).at(0);
    if (!isRecord(installed) || typeof installed["installed"] !== "boolean") {
      return null;
    }
    // Earlier migrations can run repairs before the expand-only owner exists.
    if (!installed["installed"]) {
      return { type: "not_installed" } as const;
    }
    const row = (
      await query(
        `SELECT count(*)::integer AS pending FROM (
          SELECT id FROM public.case_law_population_deltas ORDER BY id LIMIT $1
        ) pending_population_deltas`,
        [CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER + 1],
      )
    ).at(0);
    if (
      !isRecord(row) ||
      typeof row["pending"] !== "number" ||
      !Number.isInteger(row["pending"]) ||
      row["pending"] < 0 ||
      row["pending"] > CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER + 1
    ) {
      return null;
    }
    return { type: "measured", pending: row["pending"] } as const;
  });
  const signal: Signal = {
    indicator: "population_backlog",
    kind: "unknown",
    value: null,
    threshold: CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER,
    observedAt: new Date(clock()).toISOString(),
    reason: "Population backlog could not be read; maintenance held",
  };
  if (Result.isOk(reading) && reading.value !== null) {
    switch (reading.value.type) {
      case "not_installed":
        signal.kind = "not_configured";
        signal.reason = "Population owner is not installed yet";
        break;
      case "measured":
        signal.value = reading.value.pending;
        signal.kind =
          reading.value.pending > CASE_LAW_POPULATION_MAINTENANCE_HIGH_WATER
            ? "stop"
            : "normal";
        signal.reason =
          signal.kind === "stop"
            ? "Population backlog exceeds maintenance high water; maintenance held"
            : "Population backlog is within maintenance high water; maintenance admitted";
        break;
      default:
        reading.value satisfies never;
        return panic("Invalid population maintenance reading");
    }
  }
  // Injected verdicts can have no signals: retain their severity explicitly.
  let kind = verdict.kind;
  if (signal.kind === "stop" || verdict.kind === "stop") {
    kind = "stop";
  } else if (signal.kind === "unknown") {
    kind = "unknown";
  }
  return { kind, signals: [...verdict.signals, signal] };
};

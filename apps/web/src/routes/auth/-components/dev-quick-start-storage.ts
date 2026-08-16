import * as v from "valibot";

import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

import {
  DEV_QUICK_START_PHASE,
  type DevQuickStartAttempt,
} from "./dev-quick-start.logic";

const DEV_QUICK_START_STORAGE_KEY = "stella.devQuickStart.attempt";

const devQuickStartAttemptSchema = v.strictObject({
  completedPhase: v.nullable(
    v.picklist([
      DEV_QUICK_START_PHASE.authenticate,
      DEV_QUICK_START_PHASE.organization,
      DEV_QUICK_START_PHASE.skills,
      DEV_QUICK_START_PHASE.matters,
    ]),
  ),
  identity: v.strictObject({
    email: v.pipe(v.string(), v.minLength(1), v.maxLength(254)),
    organizationName: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    organizationSlug: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    selectionSeed: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  }),
  organizationId: v.nullable(
    v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  ),
});

export const parseDevQuickStartAttempt = (
  raw: string | null,
): DevQuickStartAttempt | null =>
  readStoredJson(raw, devQuickStartAttemptSchema);

export const readDevQuickStartAttempt = (): DevQuickStartAttempt | null => {
  try {
    return parseDevQuickStartAttempt(
      sessionStorage.getItem(DEV_QUICK_START_STORAGE_KEY),
    );
  } catch {
    return null;
  }
};

export const writeDevQuickStartAttempt = (
  attempt: DevQuickStartAttempt,
): void => {
  try {
    writeStoredJson(sessionStorage, DEV_QUICK_START_STORAGE_KEY, attempt);
  } catch {
    // Storage can be unavailable or blocked; persistence is best-effort.
  }
};

export const clearDevQuickStartAttempt = (): void => {
  try {
    sessionStorage.removeItem(DEV_QUICK_START_STORAGE_KEY);
  } catch {
    // Storage can be unavailable or blocked; clearing is best-effort.
  }
};

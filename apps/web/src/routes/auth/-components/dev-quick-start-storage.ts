import * as v from "valibot";

import { deviceStorage } from "@/lib/account/browser-storage";
import { readStoredJson, writeStoredJson } from "@/lib/stored-json";

import {
  DEV_QUICK_START_PHASE,
  type DevQuickStartAttempt,
} from "./dev-quick-start.logic";

// Attempts belong to a tab; another tab must not replace its org or seed.
const DEV_QUICK_START_STORAGE_KEY = "stella.devQuickStart.attempt";

const devQuickStartAttemptSchema = v.strictObject({
  completedPhase: v.nullable(v.picklist(Object.values(DEV_QUICK_START_PHASE))),
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

export const readDevQuickStartAttempt = (): DevQuickStartAttempt | null =>
  parseDevQuickStartAttempt(
    deviceStorage("session").getItem(DEV_QUICK_START_STORAGE_KEY),
  );

export const writeDevQuickStartAttempt = (
  attempt: DevQuickStartAttempt,
): void => {
  writeStoredJson(
    deviceStorage("session"),
    DEV_QUICK_START_STORAGE_KEY,
    attempt,
  );
};

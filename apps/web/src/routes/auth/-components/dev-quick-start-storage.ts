import { Result } from "better-result";
import * as v from "valibot";

import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

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

const devQuickStartEntry = definePersistedState({
  key: DEV_QUICK_START_STORAGE_KEY,
  area: "session",
  version: 1,
  schema: v.nullable(devQuickStartAttemptSchema),
  maxBytes: 4096,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: false,
});

export const parseDevQuickStartAttempt = (
  raw: string | null,
): DevQuickStartAttempt | null => {
  if (raw === null) {
    return null;
  }
  const value = Result.try(() => JSON.parse(raw) as unknown).unwrapOr(null);
  const parsed = v.safeParse(devQuickStartAttemptSchema, value);
  return parsed.success ? parsed.output : null;
};

export const readDevQuickStartAttempt = (): DevQuickStartAttempt | null =>
  readPersistedState(devQuickStartEntry, {});

export const writeDevQuickStartAttempt = (
  attempt: DevQuickStartAttempt,
): void => {
  writePersistedState(devQuickStartEntry, {}, attempt);
};

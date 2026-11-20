import * as v from "valibot";

import {
  lastTabStorageOwner,
  storageOwner,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";
import { getAnalytics } from "@/lib/analytics/provider";
import {
  definePersistedState,
  readPersistedState,
  writePersistedState,
} from "@/lib/persisted-state/registry";

const TIME_BILLING_ACCESS_STORAGE_BASE = "stella.time-billing-access";

type TimeBillingAccessScope = { organizationId: string };

const timeBillingAccessState = definePersistedState({
  key: (_scope: TimeBillingAccessScope) =>
    userStorageKey(TIME_BILLING_ACCESS_STORAGE_BASE),
  area: "local",
  version: 1,
  schema: v.object({ organizationId: v.string(), enabled: v.boolean() }),
  maxBytes: 256,
  defaultValue: () => ({ organizationId: "", enabled: false }),
  scopeCheck: (value, { organizationId }) =>
    value.organizationId === organizationId
      ? { keep: true, value }
      : { keep: false },
  restoredUi: false,
});

/**
 * The server's last decision, kept so a reload draws the same chrome before
 * the decision arrives. It only shapes that first paint: route admission and
 * every API call still answer to the server.
 */
export const rememberTimeBillingAccess = (
  organizationId: string,
  enabled: boolean,
): void => {
  const written = writePersistedState(
    timeBillingAccessState,
    { organizationId },
    { organizationId, enabled },
  );
  // The decision itself still stands; only the next reload's first paint
  // loses its hint, so the failure is reported rather than raised.
  if (written.isErr()) {
    getAnalytics().captureError(written.error, {
      fingerprintKey: "rememberTimeBillingAccess:write",
      scope: { type: "handler", handlerId: "rememberTimeBillingAccess:write" },
    });
  }
};

export const rememberedTimeBillingAccess = (organizationId: string): boolean =>
  readPersistedState(timeBillingAccessState, { organizationId }).enabled;

/**
 * The same hint for the frame drawn before the session is read (a reload's
 * first paint): the answer this browser kept for the member this tab last
 * belonged to, whichever organization it was for, read without dropping it.
 * It shapes only that paint; the sidebar reads the active organization's,
 * for the member the session names.
 */
const timeBillingAccessHintState = {
  ...timeBillingAccessState,
  key: () =>
    userStorageKey(
      TIME_BILLING_ACCESS_STORAGE_BASE,
      lastTabStorageOwner() ?? storageOwner(),
    ),
  scopeCheck: (value: { organizationId: string; enabled: boolean }) => ({
    keep: true as const,
    value,
  }),
};

export const rememberedTimeBillingAccessHint = (): boolean =>
  readPersistedState(timeBillingAccessHintState, { organizationId: "" })
    .enabled;

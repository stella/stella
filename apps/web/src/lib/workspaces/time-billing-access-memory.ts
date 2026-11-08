import * as v from "valibot";

import { userStorageKey } from "@/lib/account/user-scoped-storage";
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

import * as v from "valibot";

import { userStorageKey } from "@/lib/account/user-scoped-storage";
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
  writePersistedState(
    timeBillingAccessState,
    { organizationId },
    { organizationId, enabled },
  ).unwrapOr(undefined);
};

export const rememberedTimeBillingAccess = (organizationId: string): boolean =>
  readPersistedState(timeBillingAccessState, { organizationId }).enabled;

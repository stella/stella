import * as v from "valibot";

import { browserStateStorage } from "@/lib/account/browser-storage";
import { userStorageKey } from "@/lib/account/user-scoped-storage";

/**
 * Organizations the user created in this browser and has not yet closed the
 * setup prompt for. Creation marks one; the prompt clears it.
 */
export const ORGANIZATION_SETUP_PENDING_KEY = "stella:organization-setup:";

const organizationIdsSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.array(v.string()),
);

export const decodeSetupPending = (raw: string | null): string[] => {
  if (raw === null) {
    return [];
  }
  // Storage can be edited outside this tab; a malformed value marks nothing.
  const parsed = v.safeParse(organizationIdsSchema, raw);
  return parsed.success ? parsed.output : [];
};

export const encodeSetupPending = (organizationIds: readonly string[]) =>
  JSON.stringify(organizationIds);

/** Marks a just-created organization so its owner is offered the setup prompt. */
export const markOrganizationSetupPending = (organizationId: string) => {
  const storage = browserStateStorage("local");
  const key = userStorageKey(ORGANIZATION_SETUP_PENDING_KEY);
  const pending = decodeSetupPending(storage.getItem(key));
  if (!pending.includes(organizationId)) {
    storage.setItem(key, encodeSetupPending([...pending, organizationId]));
  }
};

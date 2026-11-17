import * as v from "valibot";

import {
  INSPECTOR_STORAGE,
  inspectorStorageBaseKey,
} from "@stll/api-contract/browser-storage";

import { userStorageKey } from "@/lib/account/user-scoped-storage";
import {
  definePersistedState,
  keepInAnyScope,
  readPersistedState,
} from "@/lib/persisted-state/registry";
import { createUuid } from "@/lib/uuid";

/** Whose inspector this is: one user inside one organization. */
export type InspectorStorageScope = {
  userId: string;
  organizationId: string;
};

const scopedKey = (
  entry: Parameters<typeof inspectorStorageBaseKey>[0],
  { userId, organizationId }: InspectorStorageScope,
) =>
  userStorageKey(inspectorStorageBaseKey(entry, organizationId), {
    kind: "user",
    userId,
  });

const inspectorStateSchema = v.nullable(
  v.object({
    tabs: v.array(v.unknown()),
    groups: v.array(v.unknown()),
    groupAssignments: v.record(v.string(), v.nullable(v.string())),
    activeId: v.nullable(v.string()),
    collapsedGroupIds: v.array(v.string()),
  }),
);

export const inspectorStateEntry = definePersistedState({
  key: (scope: InspectorStorageScope) =>
    scopedKey(INSPECTOR_STORAGE.state, scope),
  area: "local",
  version: INSPECTOR_STORAGE.state.version,
  schema: inspectorStateSchema,
  legacy: { encoding: "json", schema: inspectorStateSchema },
  maxBytes: 512_000,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const inspectorMinimizedEntry = definePersistedState({
  key: (scope: InspectorStorageScope) =>
    scopedKey(INSPECTOR_STORAGE.minimized, scope),
  area: "local",
  version: INSPECTOR_STORAGE.minimized.version,
  schema: v.boolean(),
  legacy: {
    encoding: "text",
    schema: v.pipe(
      v.picklist(["0", "1"]),
      v.transform((value) => value === "1"),
    ),
  },
  maxBytes: 128,
  defaultValue: () => false,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const inspectorRestorePendingEntry = definePersistedState({
  key: (scope: InspectorStorageScope) =>
    scopedKey(INSPECTOR_STORAGE.restorePending, scope),
  area: "session",
  version: INSPECTOR_STORAGE.restorePending.version,
  schema: v.string(),
  legacy: { encoding: "text", schema: v.pipe(v.string(), v.uuid()) },
  maxBytes: 256,
  defaultValue: () => "",
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

// The restore-pending marker records which page load set it. The id lives
// here, beside the marker, so the loading frame (before the member's inspector
// code loads) and the restoring store judge the same marker the same way.
let inspectorPageLoadId: string = createUuid();

/** A new page load: a marker an earlier one left is a stalled restore. */
export const startInspectorPageLoad = (): string => {
  inspectorPageLoadId = createUuid();
  return inspectorPageLoadId;
};

/** An earlier page load restored tabs and never settled. */
export const isInspectorRestorePending = (
  scope: InspectorStorageScope,
): boolean => {
  const marker = readPersistedState(inspectorRestorePendingEntry, scope);
  return marker !== "" && marker !== inspectorPageLoadId;
};

/** Every tab the member left open, before any restore policy filters it. */
export const countStoredInspectorTabs = (scope: InspectorStorageScope) =>
  readPersistedState(inspectorStateEntry, scope)?.tabs.length ?? 0;

/**
 * Whether the next restore opens the pane: tabs to restore, not minimized and
 * no stalled earlier restore. The one policy for every frame that reserves
 * the pane; the restoring store passes the tabs it would actually restore.
 */
export const isPersistedInspectorPaneOpen = (
  scope: InspectorStorageScope,
  countRestorableTabs: (scope: InspectorStorageScope) => number,
): boolean =>
  !readPersistedState(inspectorMinimizedEntry, scope) &&
  !isInspectorRestorePending(scope) &&
  countRestorableTabs(scope) > 0;

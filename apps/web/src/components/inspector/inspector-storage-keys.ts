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

/** Layout metadata only: the member's tab payloads stay in the lazy frame. */
export const readPersistedInspectorPaneRequested = (
  scope: InspectorStorageScope,
) =>
  (readPersistedState(inspectorStateEntry, scope)?.tabs.length ?? 0) > 0 &&
  !readPersistedState(inspectorMinimizedEntry, scope);

import * as v from "valibot";

import { userStorageKey } from "@/lib/account/user-scoped-storage";
import {
  definePersistedState,
  keepInAnyScope,
} from "@/lib/persisted-state/registry";

/** Whose inspector this is: one user inside one organization. */
export type InspectorStorageScope = {
  userId: string;
  organizationId: string;
  workspaceId?: string | undefined;
};

const scopedKey = (
  prefix: string,
  { userId, organizationId }: InspectorStorageScope,
) => userStorageKey(`${prefix}:${organizationId}:`, { kind: "user", userId });

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
    scopedKey("stella:inspector-state:v1", scope),
  area: "local",
  version: 1,
  schema: inspectorStateSchema,
  maxBytes: 512_000,
  defaultValue: () => null,
  scopeCheck: (value, scope) =>
    value === null
      ? keepInAnyScope(value)
      : keepInAnyScope({
          ...value,
          tabs: value.tabs.filter((tab) => {
            if (
              typeof tab !== "object" ||
              tab === null ||
              !("workspaceId" in tab)
            ) {
              return true;
            }
            const workspaceId = tab.workspaceId;
            return (
              typeof workspaceId !== "string" ||
              scope.workspaceId === undefined ||
              workspaceId === scope.workspaceId
            );
          }),
        }),
  restoredUi: true,
});

export const inspectorMinimizedEntry = definePersistedState({
  key: (scope: InspectorStorageScope) =>
    scopedKey("stella:inspector-minimized:v1", scope),
  area: "local",
  version: 1,
  schema: v.boolean(),
  maxBytes: 128,
  defaultValue: () => false,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const inspectorRestorePendingEntry = definePersistedState({
  key: (scope: InspectorStorageScope) =>
    scopedKey("stella:inspector-restore-pending:v1", scope),
  area: "session",
  version: 1,
  schema: v.string(),
  maxBytes: 256,
  defaultValue: () => "",
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

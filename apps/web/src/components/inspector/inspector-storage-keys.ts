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
  legacy: { encoding: "json", schema: inspectorStateSchema },
  maxBytes: 512_000,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

export const inspectorMinimizedEntry = definePersistedState({
  key: (scope: InspectorStorageScope) =>
    scopedKey("stella:inspector-minimized:v1", scope),
  area: "local",
  version: 1,
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
    scopedKey("stella:inspector-restore-pending:v1", scope),
  area: "session",
  version: 1,
  schema: v.string(),
  legacy: { encoding: "text", schema: v.pipe(v.string(), v.uuid()) },
  maxBytes: 256,
  defaultValue: () => "",
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

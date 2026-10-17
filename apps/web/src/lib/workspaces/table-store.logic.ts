import type { ColumnSizingState } from "@tanstack/react-table";
import * as v from "valibot";

import { userStorageKey } from "@/lib/account/user-scoped-storage";
import {
  definePersistedState,
  keepInAnyScope,
} from "@/lib/persisted-state/registry";

export const TABLE_STORE_VERSION = 1;

export const TABLE_CONTENT_MODES = ["tight", "fit-content"] as const;

export type TableContentMode = (typeof TABLE_CONTENT_MODES)[number];

export type TableViewRef = {
  workspaceId: string;
  viewId: string;
};

/** Per-view state keyed `record[workspaceId][viewId]`. */
export type TableViewRecord<T> = Record<string, Record<string, T>>;

/**
 * Remove the views of `workspaceId` that `keep` rejects. Drops the matter's
 * entry when no view survives. Returns the same `record` object when nothing
 * was removed, so callers can skip a store write by identity check.
 */
export const pruneMatterViews = <T>(
  record: TableViewRecord<T>,
  workspaceId: string,
  keep: (viewId: string) => boolean,
): TableViewRecord<T> => {
  const bucket = record[workspaceId];
  if (!bucket) {
    return record;
  }
  const entries = Object.entries(bucket);
  const kept = entries.filter(([viewId]) => keep(viewId));
  if (kept.length === entries.length) {
    return record;
  }
  const others = Object.fromEntries(
    Object.entries(record).filter(([id]) => id !== workspaceId),
  );
  return kept.length === 0
    ? others
    : { ...others, [workspaceId]: Object.fromEntries(kept) };
};

export type PersistedTableState = {
  columnSizing: TableViewRecord<ColumnSizingState>;
  contentMode: TableViewRecord<TableContentMode>;
};

const viewRecord = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  value: TSchema,
) => v.record(v.string(), v.record(v.string(), value));

export const tableStorageSchema = v.strictObject({
  state: v.strictObject({
    columnSizing: viewRecord(v.record(v.string(), v.number())),
    contentMode: viewRecord(v.picklist(TABLE_CONTENT_MODES)),
  }),
  version: v.literal(TABLE_STORE_VERSION),
});

export const tableStateEntry = definePersistedState({
  key: () => userStorageKey("stella:table"),
  area: "local",
  version: 1,
  schema: v.nullable(tableStorageSchema),
  maxBytes: 524_288,
  defaultValue: () => null,
  scopeCheck: keepInAnyScope,
  restoredUi: true,
});

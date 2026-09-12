import type { ColumnSizingState } from "@tanstack/react-table";
import * as v from "valibot";
import type { StorageValue } from "zustand/middleware";

import { readStoredJson } from "@/lib/stored-json";

/** No migration: a payload at any other version reads as absent. */
export const TABLE_STORE_VERSION = 1;

const TABLE_CONTENT_MODES = ["tight", "fit-content"] as const;

export type TableContentMode = (typeof TABLE_CONTENT_MODES)[number];

export type TableViewRef = {
  workspaceId: string;
  viewId: string;
};

/** Per-view state keyed `record[workspaceId][viewId]`. */
export type TableViewRecord<T> = Record<string, Record<string, T>>;

/**
 * `record` with one matter's views filtered by `keep`. An emptied matter is
 * dropped; other matters are returned as they are. Returns `record` itself
 * when nothing is filtered out, so a caller can tell a no-op by identity.
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

const StorageSchema = v.strictObject({
  state: v.strictObject({
    columnSizing: viewRecord(v.record(v.string(), v.number())),
    contentMode: viewRecord(v.picklist(TABLE_CONTENT_MODES)),
  }),
  version: v.literal(TABLE_STORE_VERSION),
});

/** Anything but a well-formed current-version payload reads as `null`. */
export const readPersistedTableState = (
  raw: string | null,
): StorageValue<PersistedTableState> | null =>
  readStoredJson(raw, StorageSchema);

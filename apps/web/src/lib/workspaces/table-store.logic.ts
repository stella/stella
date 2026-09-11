import type { ColumnSizingState } from "@tanstack/react-table";
import * as v from "valibot";
import type { StorageValue } from "zustand/middleware";

import { readStoredJson } from "@/lib/stored-json";

/**
 * Bumped when the persisted shape changes. There is no migration: a payload
 * at any other version reads as absent and the next write overwrites it.
 * Column widths and content mode are cosmetics, so a one-time reset is
 * cheaper than carrying every old shape's reader.
 */
export const TABLE_STORE_VERSION = 1;

const TABLE_CONTENT_MODES = ["tight", "fit-content"] as const;

export type TableContentMode = (typeof TABLE_CONTENT_MODES)[number];

/** A view addressed by its matter, so a per-view record cannot cross matters. */
export type TableViewRef = {
  workspaceId: string;
  viewId: string;
};

/**
 * Per-view state nested under the matter that owns the view:
 * `record[workspaceId][viewId]`. Nesting is what lets `reconcileViews` drop
 * the views one matter no longer has without touching any other matter's.
 */
export type TableViewRecord<T> = Record<string, Record<string, T>>;

export const getViewRecord = <T>(
  record: TableViewRecord<T>,
  { workspaceId, viewId }: TableViewRef,
): T | undefined => record[workspaceId]?.[viewId];

export const setViewRecord = <T>(
  record: TableViewRecord<T>,
  { workspaceId, viewId }: TableViewRef,
  value: T,
): void => {
  (record[workspaceId] ??= {})[viewId] = value;
};

/**
 * `record` with one matter's bucket replaced. An empty bucket is dropped so
 * the persisted blob does not accumulate empty objects.
 */
const withMatterBucket = <T>(
  record: TableViewRecord<T>,
  workspaceId: string,
  bucket: Record<string, T>,
): TableViewRecord<T> => {
  const others = Object.fromEntries(
    Object.entries(record).filter(([id]) => id !== workspaceId),
  );
  return Object.keys(bucket).length === 0
    ? others
    : { ...others, [workspaceId]: bucket };
};

export const withoutViewRecord = <T>(
  record: TableViewRecord<T>,
  { workspaceId, viewId }: TableViewRef,
): TableViewRecord<T> => {
  const bucket = record[workspaceId];
  if (!bucket || !(viewId in bucket)) {
    return record;
  }
  return withMatterBucket(
    record,
    workspaceId,
    Object.fromEntries(Object.entries(bucket).filter(([id]) => id !== viewId)),
  );
};

/**
 * Keep only `liveViewIds` in one matter's bucket. Other matters are
 * untouched. Idempotent.
 */
export const reconcileMatterViews = <T>(
  record: TableViewRecord<T>,
  workspaceId: string,
  liveViewIds: ReadonlySet<string>,
): TableViewRecord<T> => {
  const bucket = record[workspaceId];
  if (!bucket) {
    return record;
  }
  return withMatterBucket(
    record,
    workspaceId,
    Object.fromEntries(
      Object.entries(bucket).filter(([viewId]) => liveViewIds.has(viewId)),
    ),
  );
};

export type PersistedTableState = {
  columnSizing: TableViewRecord<ColumnSizingState>;
  contentMode: TableViewRecord<TableContentMode>;
};

const viewRecordSchema = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  value: TSchema,
) => v.record(v.string(), v.record(v.string(), value));

const StorageSchema = v.strictObject({
  state: v.strictObject({
    columnSizing: viewRecordSchema(v.record(v.string(), v.number())),
    contentMode: viewRecordSchema(v.picklist(TABLE_CONTENT_MODES)),
  }),
  version: v.literal(TABLE_STORE_VERSION),
});

/**
 * The read boundary for the persisted key. Anything but a well-formed
 * current-version payload is `null`, which `persist` treats as an empty
 * store; it never sees a version mismatch, so it never logs one.
 */
export const readPersistedTableState = (
  raw: string | null,
): StorageValue<PersistedTableState> | null =>
  readStoredJson(raw, StorageSchema);

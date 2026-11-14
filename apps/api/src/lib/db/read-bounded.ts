import { panic } from "better-result";

import { createCursorPage } from "@/api/lib/pagination";

type BoundedReadQuery<TRow> = {
  limit: (limit: number) => PromiseLike<TRow[]>;
};

export type BoundedReadResult<TRow> =
  { type: "complete"; rows: TRow[] } | { type: "overflow"; cap: number };

const boundedReadLimit = (cap: number) => {
  if (!Number.isSafeInteger(cap) || cap < 0 || cap >= Number.MAX_SAFE_INTEGER) {
    panic(
      "Bounded read cap must be a nonnegative safe integer with room for an overflow probe",
      { cap },
    );
  }
  return cap + 1;
};

/** Reads one extra row to distinguish a complete export from a truncated one. */
export const readBounded = async <TRow>(
  query: BoundedReadQuery<TRow>,
  cap: number,
): Promise<BoundedReadResult<TRow>> => {
  const rows = await query.limit(boundedReadLimit(cap));
  if (rows.length > cap) {
    return { type: "overflow", cap };
  }

  return { type: "complete", rows };
};

type GroupedReadQuery<TLimited> = { limit: (limit: number) => TLimited };
type GroupedReadOptions<TLimited, TRow> = {
  cap: number;
  readRows: (limited: TLimited) => PromiseLike<TRow[]>;
  groupKeyOf: (row: TRow) => PropertyKey;
};

/** A lateral query probes each group's sentinel before any complete rows escape. */
export const readBoundedByGroup = async <TLimited, TRow>(
  query: GroupedReadQuery<TLimited>,
  { cap, readRows, groupKeyOf }: GroupedReadOptions<TLimited, TRow>,
): Promise<BoundedReadResult<TRow>> => {
  const limited = query.limit(boundedReadLimit(cap));
  const rows = await readRows(limited);
  const counts = new Map<PropertyKey, number>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    const count = (counts.get(key) ?? 0) + 1;
    if (count > cap) {
      return { type: "overflow", cap };
    }
    counts.set(key, count);
  }
  return { type: "complete", rows };
};

type CursorReadOptions<TRow> = {
  limit: number;
  cursorForItem: (row: TRow) => string;
};

/** A sentinel preserves continuation when a worker fills its current page. */
export const readCursorPage = async <TRow>(
  query: BoundedReadQuery<TRow>,
  { limit, cursorForItem }: CursorReadOptions<TRow>,
) => {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit >= Number.MAX_SAFE_INTEGER
  ) {
    panic(
      "Cursor reads require a positive safe limit with room for a sentinel",
      { limit },
    );
  }
  return createCursorPage({
    rows: await query.limit(limit + 1),
    limit,
    cursorForItem,
  });
};

export const BOUNDED_READ_EXPORTS = {
  readBounded,
  readBoundedByGroup,
  readCursorPage,
} as const;

import { panic } from "better-result";

type BoundedReadQuery<TRow> = {
  limit: (limit: number) => PromiseLike<TRow[]>;
};

export type BoundedReadResult<TRow> =
  | { type: "complete"; rows: TRow[] }
  | { type: "overflow"; cap: number };

/** Reads one extra row to distinguish a complete export from a truncated one. */
export const readBounded = async <TRow>(
  query: BoundedReadQuery<TRow>,
  cap: number,
): Promise<BoundedReadResult<TRow>> => {
  if (!Number.isSafeInteger(cap) || cap < 0 || cap >= Number.MAX_SAFE_INTEGER) {
    return panic(
      "Bounded read cap must be a nonnegative safe integer with room for an overflow probe",
      { cap },
    );
  }

  const rows = await query.limit(cap + 1);
  if (rows.length > cap) {
    return { type: "overflow", cap };
  }

  return { type: "complete", rows };
};

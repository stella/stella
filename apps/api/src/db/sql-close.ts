import type { ReservedSQL, SQL } from "bun";

const POOL_FORCE_CLOSE_TIMEOUT_SECONDS = 0.001;

/** Pooled SQL.close(0) drains queries; its termination budget is in seconds. */
export const forceClosePool = async (
  pool: Pick<SQL, "close">,
): Promise<void> => {
  await pool.close({ timeout: POOL_FORCE_CLOSE_TIMEOUT_SECONDS });
};

type ReservedCloseTarget = Pick<ReservedSQL, "close" | "release">;

/** Close the physical reserved session without entering Bun's positive-timeout promise path. */
export const terminateReserved = async (
  reserved: ReservedCloseTarget,
): Promise<void> => {
  // Unlike pooled close, reserved close(0) cancels queries and closes immediately:
  // https://github.com/oven-sh/bun/blob/bun-v1.4.3/src/js/bun/sql.ts#L483-L488
  await reserved.close({ timeout: 0 });
};

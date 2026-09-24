import { Result } from "better-result";

import { rootDb } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";

/**
 * Owner-level transactions for instance maintenance: scheduler passes and
 * operator scripts whose work spans every tenant or the global corpus, so no
 * workspace scope can describe it. Row-level policies do not apply; the
 * caller owns the bounds of what it touches.
 */
export const maintenanceScopedDb: ScopedDb = async (run) =>
  await rootDb.transaction(run);

/** Result-wrapped form of `maintenanceScopedDb`. */
export const maintenanceSafeDb: SafeDb = async (run) =>
  await Result.tryPromise(async () => await rootDb.transaction(run));

import type { Transaction } from "@/api/db/root";

// Re-export scoped utilities without pulling in the owner-level
// db initialization. Runtime imports from `@/api/db` stay safe for
// handlers and tests; `db` now lives in `@/api/db/root`.
export { createScopedDb } from "@/api/db/scoped";
export type { AnyDrizzle, TransactionOf } from "@/api/db/scoped";
export type { Transaction } from "@/api/db/root";

/**
 * Scoped database handle that wraps every operation in a
 * short-lived RLS transaction. Each call to `scopedDb(fn)`
 * opens a transaction, switches to the `stella` role (which
 * activates RLS), sets `app.workspace_ids` and
 * `app.organization_id` via SET LOCAL, runs `fn`, and
 * commits. The connection returns to the pool immediately
 * after; safe with PgBouncer in transaction mode.
 *
 * Handlers receive this from `authMacro` and must never
 * import `db` directly.
 */
export type ScopedDb = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

/**
 * Self-referencing trees and the database guard that keeps them acyclic.
 *
 * Every table whose `parent_id` references its own `id` carries the
 * `guard_tree_parent` trigger (migration 20261004003000). It runs after each
 * inserted or reparented row, once the whole statement's rows are visible,
 * requires the parent in the same scope and walks the parent chain; a row that
 * would close a loop is refused with `check_violation` naming the tree's
 * constraint, including a loop built inside one bulk INSERT. Parent-changing
 * updates and inserts with a parent require READ COMMITTED, so a lock wait can
 * refresh the ancestry snapshot. Roots and unchanged parents are exempt.
 * A reparent first takes the tree's lock, so opposite concurrent moves cannot
 * both commit, whatever the handler does. An insert takes no lock: a loop
 * through a new row is closed either inside its own statement or by a
 * reparent, which locks.
 *
 * Writers still take the same lock first, in their own transaction, before any
 * row lock, and keep a readable pre-check: the trigger then re-acquires a lock
 * its transaction already holds, and its refusal is mapped to the pre-check's
 * error by `treeParentCycleError`.
 *
 * This registry is the one source for the trigger arguments. The guard tests
 * compare it with the drizzle schema (every self-referencing foreign key is a
 * registered tree or a reasoned exemption) and with the installed triggers.
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgConstraintError } from "@/api/lib/pg-error";

/** SQLSTATE every tree refusal raises: `check_violation`. */
export const TREE_PARENT_GUARD_SQLSTATE = "23514";

/** Error code of a refused reparent, from the pre-check or the trigger. */
export const TREE_PARENT_CYCLE_ERROR_CODE = "tree_parent_cycle";

/** Second key of the clause-category tree lock; the organization hash is the first. */
const CLAUSE_CATEGORY_TREE_LOCK_NAMESPACE = 0x43_4c_43_54;

type TreeLock =
  /** The matter row `FOR UPDATE`, as `lockWorkspacesForEntityCap` takes it. */
  | { readonly kind: "workspace-row" }
  /**
   * `pg_advisory_xact_lock(hashtext(organization_id))`: the organization
   * catalog lock template-category creation already takes.
   */
  | { readonly kind: "organization-catalog" }
  /** `pg_advisory_xact_lock(namespace, hashtext(scope))`. */
  | { readonly kind: "advisory"; readonly namespace: number };

type TreeParentGuard = {
  /** Table name; its parent column is `parent_id`, referencing `id`. */
  readonly table: string;
  /** Column naming the tree a row belongs to; parents share it. */
  readonly scopeColumn: string;
  readonly lock: TreeLock;
  /** Trigger name and the constraint name its refusals report. */
  readonly constraint: string;
};

export const TREE_PARENT_GUARDS = {
  entities: {
    table: "entities",
    scopeColumn: "workspace_id",
    lock: { kind: "workspace-row" },
    constraint: "entities_parent_acyclic",
  },
  clauseCategories: {
    table: "clause_categories",
    scopeColumn: "organization_id",
    lock: { kind: "advisory", namespace: CLAUSE_CATEGORY_TREE_LOCK_NAMESPACE },
    constraint: "clause_categories_parent_acyclic",
  },
  templateCategories: {
    table: "template_categories",
    scopeColumn: "organization_id",
    lock: { kind: "organization-catalog" },
    constraint: "template_categories_parent_acyclic",
  },
} as const satisfies Record<string, TreeParentGuard>;

export type TreeName = keyof typeof TREE_PARENT_GUARDS;

/**
 * Self-referencing foreign keys that are not trees a writer reparents, keyed
 * `table.column[,column]`. Each needs a reason; the list only shrinks.
 */
export const SELF_REFERENCE_EXEMPTIONS: Readonly<Record<string, string>> = {
  "chat_threads.parent_thread_id":
    "Written once, when a fork is inserted, to the thread it was forked from; a new row has no descendants and no writer changes it later.",
  "ai_memories.superseded_by_id":
    "No writer sets it; the column only goes null when the superseding memory is deleted.",
  "invoices.original_invoice_id,workspace_id":
    "A credit note may only reference a finalized invoice that is not itself a credit note (invoices/document-type.ts, under that row's lock), so the link is one level deep.",
};

/** The `guard_tree_parent` arguments the tree's trigger must be installed with. */
export const treeParentTriggerArguments = (
  guard: TreeParentGuard,
): readonly string[] => [
  guard.scopeColumn,
  guard.lock.kind,
  guard.lock.kind === "advisory" ? String(guard.lock.namespace) : "",
  guard.constraint,
];

type LockTreeTarget =
  | { readonly tree: "entities"; readonly scopeId: SafeId<"workspace"> }
  | {
      readonly tree: "clauseCategories" | "templateCategories";
      readonly scopeId: SafeId<"organization">;
    };

/**
 * Take the tree's lock. Call it first in the transaction that reads the parent
 * chain and writes `parent_id`, before any row lock, so the pre-check and the
 * write see the same tree.
 */
export const lockTree = async (
  tx: Transaction,
  target: LockTreeTarget,
): Promise<void> => {
  if (target.tree === "entities") {
    TREE_PARENT_GUARDS.entities.lock satisfies { kind: "workspace-row" };
    await lockWorkspacesForEntityCap(tx, [target.scopeId]);
    return;
  }
  const { lock } = TREE_PARENT_GUARDS[target.tree];
  switch (lock.kind) {
    case "organization-catalog":
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${target.scopeId}))`,
      );
      return;
    case "advisory":
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${lock.namespace}, hashtext(${target.scopeId}))`,
      );
      return;
    default:
      lock satisfies never;
      return panic("Unhandled tree lock kind");
  }
};

/** True when the tree's trigger refused a parent change. */
export const isTreeParentGuardError = (
  error: unknown,
  tree: TreeName,
): boolean =>
  isPgConstraintError(
    error,
    TREE_PARENT_GUARD_SQLSTATE,
    TREE_PARENT_GUARDS[tree].constraint,
  );

/** The refusal a reparent returns, whether its pre-check or the trigger caught it. */
export const treeParentCycleError = (message: string) =>
  new HandlerError({
    code: TREE_PARENT_CYCLE_ERROR_CODE,
    status: 400,
    message,
    retryable: false,
  });

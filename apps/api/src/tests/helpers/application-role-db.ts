import type { Transaction } from "@/api/db/root";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type {
  AnyDrizzle,
  RlsDatabase,
  RlsDatabaseMarker,
} from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createRootMembershipScopedDb,
  createRootSafeDb,
  createRootScopedDb,
} from "@/api/lib/root-scoped-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * Database handles for database tests, built by the factories production code
 * receives its handles from, so the code under test runs on the application
 * role with row security on.
 *
 * The test database itself connects as the owner, which row security never
 * refuses. A test that hands it (or a transaction opened on it) to the code
 * under test passes even when production would refuse the same write. Seed
 * and assert through the test database; run the code under test through these.
 */

type MemberScope = {
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
  userId: SafeId<"user">;
};

/**
 * The test database typed as production's row-security database, for the
 * handle factories that take one (`createRootRunActor`, `createScopedDb`).
 * Every transaction they open switches to the application role.
 */
export const applicationRoleDatabase = (
  database: AnyDrizzle & RlsDatabaseMarker,
): RlsDatabase<Transaction> =>
  // The test database runs the same schema, roles and policies; only its
  // driver's transaction type differs from production's.
  asTestRaw<RlsDatabase<Transaction>>(database);

/** A member's handle on the matters in `scope`, as a matter route or a
 *  queued run's writes get it: the application role, scoped to `scope`. */
export const memberScopedDb = (
  database: AnyDrizzle & RlsDatabaseMarker,
  scope: MemberScope,
): ScopedDb => createRootScopedDb(scope, applicationRoleDatabase(database));

/** The `Result` form of `memberScopedDb`. */
export const memberSafeDb = (
  database: AnyDrizzle & RlsDatabaseMarker,
  scope: MemberScope,
): SafeDb => createRootSafeDb(scope, applicationRoleDatabase(database));

/** A member's handle for an organization route: the application role,
 *  reaching the matters the member belongs to as each transaction runs. */
export const membershipScopedDb = (
  database: AnyDrizzle & RlsDatabaseMarker,
  member: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
): ScopedDb =>
  createRootMembershipScopedDb(member, applicationRoleDatabase(database));

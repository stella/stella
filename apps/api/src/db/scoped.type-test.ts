import type { SafeId } from "../lib/branded-types";
import type { RlsDatabase } from "./scoped";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
} from "./scoped";

declare const database: RlsDatabase;
declare const organizationId: SafeId<"organization">;
declare const userId: SafeId<"user">;

// @ts-expect-error Every explicit scoped factory requires a budget decision.
createScopedDb(database, { organizationId, userId, workspaceScope: [] });
// @ts-expect-error Every explicit safe factory requires a budget decision.
createSafeDb(database, { organizationId, userId, workspaceIds: [] });
// @ts-expect-error Membership-derived scopes also require a budget decision.
createMembershipScopedDb(database, {
  organizationId,
  userId,
  serverValidatedWorkspaceIds: [],
});
// @ts-expect-error Membership-derived safe scopes also require a budget decision.
createMembershipSafeDb(database, {
  organizationId,
  userId,
  serverValidatedWorkspaceIds: [],
});
// @ts-expect-error Tenantless lookup transactions require a budget decision.
createTenantlessDb(database);

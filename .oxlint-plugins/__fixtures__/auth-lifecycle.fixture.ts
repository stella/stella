// Passive regression fixture for both `auth-lifecycle` rules.

import * as authTables from "@/api/db/auth-schema";
import {
  authSchema,
  oauthAccessToken,
  session as sessionTable,
} from "@/api/db/auth-schema";
import * as artifacts from "@/api/lib/auth-artifacts";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";

declare const db: {
  delete: (table: unknown) => unknown;
};
declare const unrelatedTable: unknown;
declare const shouldRevoke: boolean;
declare const failure: Error;

export const missingCleanupHooks = {
  // The lifecycle hook omits the canonical cleanup helper.
  // oxlint-disable-next-line auth-lifecycle/after-remove-member-revokes-artifacts -- fixture: membership removal must revoke every auth artifact
  afterRemoveMember: () => db.delete(unrelatedTable),
};

export const localHelperHooks = () => {
  // oxlint-disable-next-line no-shadow -- fixture: same-named local helper
  const revokeOrganizationMemberAuthArtifacts = () => undefined;
  return {
    // A local function is not the canonical cleanup helper.
    // oxlint-disable-next-line auth-lifecycle/after-remove-member-revokes-artifacts -- fixture: only the owning module's helper counts
    afterRemoveMember: () => revokeOrganizationMemberAuthArtifacts(),
  };
};

export const afterReturnHooks = {
  // The helper call after a return never runs.
  // oxlint-disable-next-line auth-lifecycle/after-remove-member-revokes-artifacts -- fixture: unreachable call after return
  afterRemoveMember: () => {
    return undefined;
    // oxlint-disable-next-line no-unreachable -- fixture: unreachable call
    revokeOrganizationMemberAuthArtifacts();
  },
};

export const afterThrowHooks = {
  // The helper call after a throw never runs.
  // oxlint-disable-next-line auth-lifecycle/after-remove-member-revokes-artifacts -- fixture: unreachable call after throw
  afterRemoveMember: () => {
    throw failure;
    // oxlint-disable-next-line no-unreachable -- fixture: unreachable call
    revokeOrganizationMemberAuthArtifacts();
  },
};

export const constantFalseHooks = {
  // The helper call sits in a constant-false branch.
  // oxlint-disable-next-line auth-lifecycle/after-remove-member-revokes-artifacts -- fixture: constant-false branch
  afterRemoveMember: () => {
    // oxlint-disable-next-line no-constant-condition, typescript/no-unnecessary-condition -- fixture: constant-false branch
    if (false) {
      revokeOrganizationMemberAuthArtifacts();
    }
  },
};

export const safeHooks = {
  // The helper may be nested inside the lifecycle hook body.
  // expect-clean: auth-lifecycle/after-remove-member-revokes-artifacts
  afterRemoveMember: () => {
    const revoke = revokeOrganizationMemberAuthArtifacts();
    return revoke;
  },
};

export const conditionalHooks = {
  // A runtime condition may guard the helper.
  // expect-clean: auth-lifecycle/after-remove-member-revokes-artifacts
  afterRemoveMember: () => {
    if (shouldRevoke) {
      artifacts.revokeOrganizationMemberAuthArtifacts();
    }
  },
};

// Direct deletion of a canonical artifact table.
// oxlint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- fixture: aliased import
export const directSessionDelete = db.delete(sessionTable);

// Every canonical OAuth artifact table is protected too.
// oxlint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- fixture: OAuth token deletion must cross the lifecycle boundary
export const directOAuthDelete = db.delete(oauthAccessToken);

// Namespace member of the auth schema module.
// oxlint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- fixture: namespace import
export const namespaceDelete = db.delete(authTables.oauthRefreshToken);

// Member of the exported schema object.
// oxlint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- fixture: schema object member
export const schemaObjectDelete = db.delete(authSchema.session);

// Unrelated database deletes do not belong to this lifecycle.
// expect-clean: auth-lifecycle/no-direct-auth-artifact-delete
export const unrelatedDelete = db.delete(unrelatedTable);

// A local named like a protected table is not the schema export.
export const localNamedDelete = () => {
  const session = unrelatedTable;
  // expect-clean: auth-lifecycle/no-direct-auth-artifact-delete
  return db.delete(session);
};

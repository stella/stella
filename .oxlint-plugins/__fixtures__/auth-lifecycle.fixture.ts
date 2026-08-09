// Passive regression fixture for both `auth-lifecycle` rules.

declare const db: {
  delete: (table: unknown) => unknown;
};
declare const oauthAccessToken: unknown;
declare const revokeOrganizationMemberAuthArtifacts: () => unknown;
declare const session: unknown;
declare const unrelatedTable: unknown;

export const missingCleanupHooks = {
  // MUST flag: the lifecycle hook omits the canonical cleanup helper.
  // oxlint-disable-next-line auth-lifecycle/after-remove-member-revokes-artifacts -- fixture: membership removal must revoke every auth artifact
  afterRemoveMember: () => db.delete(unrelatedTable),
};

// Allowed: the helper may be nested inside the lifecycle hook body.
export const safeHooks = {
  afterRemoveMember: () => {
    const revoke = revokeOrganizationMemberAuthArtifacts();
    return revoke;
  },
};

// MUST flag: direct deletion of a canonical artifact table bypasses cleanup.
// oxlint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- fixture: session deletion must cross the lifecycle boundary
export const directSessionDelete = db.delete(session);

// MUST flag: every canonical OAuth artifact table is protected too.
// oxlint-disable-next-line auth-lifecycle/no-direct-auth-artifact-delete -- fixture: OAuth token deletion must cross the lifecycle boundary
export const directOAuthDelete = db.delete(oauthAccessToken);

// Allowed: unrelated database deletes do not belong to this lifecycle.
export const unrelatedDelete = db.delete(unrelatedTable);

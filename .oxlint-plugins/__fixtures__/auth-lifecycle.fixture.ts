// Passive regression fixture for both authentication lifecycle rules.
import * as authTables from "@/api/db/auth-schema";
import {
  authSchema,
  oauthAccessToken,
  session as sessionTable,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import * as artifacts from "@/api/lib/auth-artifacts";
import {
  removeOrganizationMemberWithAuthArtifacts as removeMember,
  revokeOrganizationMemberAuthArtifacts,
} from "@/api/lib/auth-artifacts";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";

declare const db: {
  delete: (table: unknown) => unknown;
  transaction: typeof rootDb.transaction;
};
declare const unrelatedTable: unknown;
declare const shouldRevoke: boolean;
declare const failure: Error;
declare const scope: Parameters<typeof removeMember>[1];
declare const transaction: Parameters<typeof removeMember>[0];
declare const Result: {
  tryPromise: (options: {
    try: () => Promise<unknown>;
    catch: (cause: unknown) => Error;
  }) => Promise<unknown>;
};
declare const toError: (cause: unknown) => Error;
declare const offboarding: Parameters<
  typeof removeOrganizationMemberInTransaction
>[1];

export const notificationOrganizationOptions = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: required before hook
  organizationHooks: {
    afterRemoveMember: () => db.delete(unrelatedTable),
  },
};
export const spreadOrganizationOptions = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: explicit before hook required
  organizationHooks: { ...{} },
};
export const completeOrganizationOptions = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  organizationHooks: {
    // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
    beforeRemoveMember: async () => {
      await rootDb.transaction(async (tx) => {
        await removeMember(tx, scope);
      });
    },
    // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
    afterRemoveMember: () => db.delete(unrelatedTable),
  },
};

export const afterNotificationHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  afterRemoveMember: () => db.delete(unrelatedTable),
};
export const afterCleanupHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: cleanup belongs to the before transaction
  afterRemoveMember: async () => {
    await revokeOrganizationMemberAuthArtifacts(transaction, scope);
  },
};
export const outsideTransactionHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: caller transaction required
  beforeRemoveMember: async () => {
    await removeMember(transaction, scope);
  },
};
export const localTransactionHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: imported root transaction required
  beforeRemoveMember: async () => {
    await db.transaction(async (tx) => {
      await removeMember(tx, scope);
    });
  },
};
export const afterReturnHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: unreachable operation
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      return undefined;
      // oxlint-disable-next-line no-unreachable -- fixture: unreachable operation
      await removeMember(tx, scope);
    });
  },
};
export const afterThrowHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: completed callback
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      throw failure;
      // oxlint-disable-next-line no-unreachable -- fixture: completed callback
      await removeMember(tx, scope);
    });
  },
};
export const constantFalseHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: conditional operation
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      // oxlint-disable-next-line no-constant-condition, typescript/no-unnecessary-condition -- fixture: fixed condition
      if (false) {
        await removeMember(tx, scope);
      }
    });
  },
};
export const conditionalHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: operation must always run
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      if (shouldRevoke) {
        await removeMember(tx, scope);
      }
    });
  },
};
export const conditionalTransactionHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: transaction must always run
  beforeRemoveMember: async () => {
    if (shouldRevoke) {
      await rootDb.transaction(async (tx) => {
        await removeMember(tx, scope);
      });
    }
  },
};
export const uncalledCallbackHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: operation must run in the callback
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      const later = async () => {
        await removeMember(tx, scope);
      };
      await Promise.resolve(later);
    });
  },
};
export const differentTransactionHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: callback transaction required
  beforeRemoveMember: async () => {
    await rootDb.transaction(async () => {
      await removeMember(transaction, scope);
    });
  },
};
export const guardedHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      if (shouldRevoke) {
        throw failure;
      }
      await removeMember(tx, scope);
    });
  },
};
export const earlyReturnHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: successful early exit skips the operation
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      if (shouldRevoke) {
        return;
      }
      await removeMember(tx, scope);
    });
  },
};
export const nestedReturnHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      const evaluate = () => shouldRevoke;
      if (evaluate()) {
        throw failure;
      }
      await removeMember(tx, scope);
    });
  },
};
export const safeHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      await removeMember(tx, scope);
    });
  },
};
export const namespaceHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      await artifacts.removeOrganizationMemberWithAuthArtifacts(tx, scope);
    });
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
export const resultWrappedTransactionHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  beforeRemoveMember: async () => {
    const removal = await Result.tryPromise({
      try: async () =>
        await rootDb.transaction(async (tx) => {
          await removeMember(tx, scope);
        }),
      catch: toError,
    });
    return removal;
  },
};
export const resultWrappedWithoutTransactionHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: wrapper still needs the root transaction
  beforeRemoveMember: async () => {
    const removal = await Result.tryPromise({
      try: async () => {
        await removeMember(transaction, scope);
      },
      catch: toError,
    });
    return removal;
  },
};
export const offboardingHooks = {
  // expect-clean: auth-lifecycle/member-removal-revokes-artifacts
  beforeRemoveMember: async () => {
    await rootDb.transaction(async (tx) => {
      await removeOrganizationMemberInTransaction(tx, offboarding);
    });
  },
};
export const offboardingOutsideTransactionHooks = {
  // oxlint-disable-next-line auth-lifecycle/member-removal-revokes-artifacts -- fixture: offboarding still needs the root transaction
  beforeRemoveMember: async () => {
    await removeOrganizationMemberInTransaction(transaction, offboarding);
  },
};

import { and, asc, eq, gt } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// Account-level access to the auth `user` row.
//
// Every query here is keyed by the one account it acts for: the caller's own
// session user id, or the email an OTP or sign-in request names before any
// organization context exists. Membership reads are likewise filtered by the
// caller's user id and return no organization row data. This module is listed
// in the user-query lint rule's `allowedFiles` for these account-scoped reads.

const DELETED_ACCOUNT_DISPLAY_NAME = "Deleted account";

const ACCOUNT_PROFILE_PROJECTION = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  image: user.image,
  timezoneId: user.timezoneId,
  preferredName: user.preferredName,
  wordEditShortcut: user.wordEditShortcut,
  userShortcuts: user.userShortcuts,
  guideProgress: user.guideProgress,
  detectedCountry: user.detectedCountry,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
} as const;

/** Reads only one account's profile through the account-row owner. */
export const readAccountProfileForExport = async (
  database: Pick<typeof rootDb, "select">,
  userId: SafeId<"user">,
) => {
  const rows = await database
    .select(ACCOUNT_PROFILE_PROJECTION)
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows.at(0);
};

const ACCOUNT_MEMBERSHIP_PAGE_SIZE = 100;

type ListAccountMembershipPageOptions = {
  database: Pick<typeof rootDb, "select">;
  userId: SafeId<"user">;
  after?: string;
};

/** Reads this account's memberships in bounded organization/id order. */
export const listAccountMembershipPage = async ({
  database,
  userId,
  after,
}: ListAccountMembershipPageOptions) =>
  await database
    .select({
      id: member.id,
      organizationId: member.organizationId,
      role: member.role,
      createdAt: member.createdAt,
    })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        after === undefined ? undefined : gt(member.id, after),
      ),
    )
    .orderBy(asc(member.id))
    .limit(ACCOUNT_MEMBERSHIP_PAGE_SIZE);

/** The caller's own email and two-factor enrollment, by their user id. */
export const readAccountEmailAndTwoFactor = async (
  userId: SafeId<"user">,
): Promise<{ email: string; twoFactorEnabled: boolean } | undefined> => {
  const rows = await rootDb
    .select({ email: user.email, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows.at(0);
};

/** The caller's own email, by their user id. */
export const readAccountEmail = async (
  userId: SafeId<"user">,
): Promise<string | undefined> => {
  const rows = await rootDb
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows.at(0)?.email;
};

/** The id of the account registered under `email`, if one exists. */
export const findAccountIdByEmail = async (
  email: string,
): Promise<string | undefined> => {
  const rows = await rootDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return rows.at(0)?.id;
};

/** Locks the account row registered under `email` for this transaction. */
export const lockAccountRowByEmail = async (
  tx: Transaction,
  email: string,
): Promise<void> => {
  await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .for("update");
};

/** Locks the caller's own account row for this transaction. */
export const lockAccountRow = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<void> => {
  // Drain membership-locked writers before erasure without blocking their
  // foreign-key KEY SHARE locks. The account's key is retained on deletion.
  await withAggregateRowQuery({
    tx,
    aggregate: "account",
    id: userId,
    mode: "no key update",
    select: (lockedTx) => lockedTx.select({ id: user.id }).from(user),
  });
};

/**
 * Shares the account row while issuing a durable credential. Access recovery
 * takes {@link lockAccountRow}, which conflicts with this mode, so issuance and
 * recovery serialize while concurrent issuers do not block each other.
 */
export const shareAccountRow = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<void> => {
  await withAggregateRowQuery({
    tx,
    aggregate: "account",
    id: userId,
    mode: "share",
    select: (lockedTx) => lockedTx.select({ id: user.id }).from(user),
  });
};

/** Share the erasure lock before starting or completing account-owned work. */
export const lockActiveAccountRow = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<void> => {
  const result = await withAggregateRowQuery({
    tx,
    aggregate: "account",
    id: userId,
    mode: "no key update",
    select: (lockedTx) =>
      lockedTx.select({ id: user.id, deletedAt: user.deletedAt }).from(user),
  });
  const row = result.rows.at(0);
  if (row === undefined || row.deletedAt !== null) {
    abortTransaction(
      new HandlerError({
        status: 404,
        code: "account_export_account_missing",
        message: "Account not found.",
      }),
    );
  }
};

/**
 * Marks the caller's own account deleted and releases its private contact and
 * login fields. The row stays for attribution in collaborative records.
 */
export const anonymizeDeletedAccountRow = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<void> => {
  await tx
    .update(user)
    .set({
      email: `deleted-${userId}@stella.placeholder`,
      emailVerified: false,
      image: null,
      name: DELETED_ACCOUNT_DISPLAY_NAME,
      preferredName: null,
      wordEditShortcut: null,
      deletedAt: new Date(),
    })
    .where(eq(user.id, userId));
};

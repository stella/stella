import { eq } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

// Account-level access to the auth `user` row.
//
// Every query here is keyed by the one account it acts for: the caller's own
// session user id, or the email an OTP or sign-in request names before any
// organization context exists. None reads another account's data, so the
// organization-membership scope the user-query lint rule asks for does not
// apply; this module is listed in that rule's `allowedFiles` for that reason.
// Keep it to such single-account reads and writes.

const DELETED_ACCOUNT_DISPLAY_NAME = "Deleted account";

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
  await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for("update");
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

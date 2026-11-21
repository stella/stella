import { lt, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { emailDeliveryFailures } from "@/api/db/schema";
import {
  markAccountEmailsUndeliverable,
  readAccountEmailUndeliverable,
} from "@/api/lib/db/account-row";
import type { EmailDeliveryFailure } from "@/api/lib/email/deliverability";
import type { AccountEmailUndeliverableReason } from "@/api/lib/email/deliverability-contract";
import type { NormalizedEmail } from "@/api/lib/email/normalized-email";

// A transactional recipient and a provider event both name an address, not a
// tenant, so the account that uses it is found and marked on the owner
// connection. Only the refusal columns and the per-address failure table are
// read or written.

/** How long a recorded delivery failure is kept, and so shown at sign-in. */
export const EMAIL_DELIVERY_FAILURE_RETENTION_DAYS = 7;

/** Why mail to this address is refused, or undefined when it is not. */
export const readRecipientRefusal = async (email: NormalizedEmail) =>
  await readAccountEmailUndeliverable(rootDb, email);

/** Records the provider's refusal on the accounts using these addresses. */
export const recordRecipientRefusals = async (
  emails: readonly NormalizedEmail[],
  reason: AccountEmailUndeliverableReason,
  at: Date,
) =>
  await markAccountEmailsUndeliverable({
    database: rootDb,
    emails,
    reason,
    at,
  });

/**
 * Records the latest failure for each address, account or not, in one
 * statement; `failures` names each address once. A failure older than the
 * stored one (a late or redelivered event) changes nothing, so replays
 * converge. Returns how many addresses were written.
 */
export const recordRecipientFailures = async (
  failures: readonly EmailDeliveryFailure[],
  at: Date,
): Promise<number> => {
  if (failures.length === 0) {
    return 0;
  }
  // audit: skip - Provider delivery bookkeeping per address; no member action or tenant data.
  const written = await rootDb
    .insert(emailDeliveryFailures)
    .values(
      failures.map(({ email, reason }) => ({
        address: email,
        reason,
        failedAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: emailDeliveryFailures.address,
      set: {
        reason: sql`excluded.reason`,
        failedAt: sql`excluded.failed_at`,
      },
      // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both sides are stored provider event times written from the same millisecond Dates; nothing is round-tripped
      setWhere: sql`excluded.failed_at >= ${emailDeliveryFailures.failedAt}`,
    })
    .returning({ address: emailDeliveryFailures.address });
  return written.length;
};

/** Deletes failures past retention; returns how many were deleted. */
export const pruneRecipientFailures = async (): Promise<number> => {
  // audit: skip - Retention expiry of provider delivery bookkeeping; no member action.
  const pruned = await rootDb
    .delete(emailDeliveryFailures)
    .where(
      lt(
        emailDeliveryFailures.failedAt,
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- the cutoff is the database clock minus whole days; no Date is compared
        sql`now() - make_interval(days => ${EMAIL_DELIVERY_FAILURE_RETENTION_DAYS})`,
      ),
    )
    .returning({ address: emailDeliveryFailures.address });
  return pruned.length;
};

import { rootDb } from "@/api/db/root";
import {
  markAccountEmailUndeliverable,
  readAccountEmailUndeliverable,
} from "@/api/lib/db/account-row";
import type { AccountEmailUndeliverableReason } from "@/api/lib/email/deliverability-contract";
import type { NormalizedEmail } from "@/api/lib/email/normalized-email";

// A transactional recipient and a provider event both name an address, not a
// tenant, so the account that uses it is found and marked on the owner
// connection. Only the refusal columns are read or written.

/** Why mail to this address is refused, or undefined when it is not. */
export const readRecipientRefusal = async (email: NormalizedEmail) =>
  await readAccountEmailUndeliverable(rootDb, email);

/** Records the provider's refusal on the account using this address. */
export const recordRecipientRefusal = async (
  email: NormalizedEmail,
  reason: AccountEmailUndeliverableReason,
  at: Date,
) =>
  await markAccountEmailUndeliverable({ database: rootDb, email, reason, at });

import { rootDb } from "@/api/db/root";
import { revokeAllUserDurableCredentials } from "@/api/lib/auth-artifacts";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

/**
 * A confirmed email OTP access reset ends every durable credential of the
 * account. It runs on the owner connection because the reset happens before
 * any session or organization scope exists.
 */
export const revokeCredentialsForAccessReset = async (
  userId: SafeId<"user">,
): Promise<void> =>
  await withAggregateTransaction(
    rootDb,
    async (tx) => await revokeAllUserDurableCredentials(tx, userId),
  );

import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { readAccountEmailAndTwoFactor } from "@/api/lib/db/account-row";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Fetches the user's email and current 2FA enrollment state by ID. The
 * lookup is by the caller's own (session-verified) user ID, not scoped to
 * an organization/workspace — there is no cross-tenant data to leak here.
 */
export const getUserEmailAndTwoFactorEnabled = async (
  currentUserId: SafeId<"user">,
): Promise<
  Result<{ email: string; twoFactorEnabled: boolean }, HandlerError>
> =>
  await Result.tryPromise({
    try: async () => {
      const row = await readAccountEmailAndTwoFactor(currentUserId);
      if (!row) {
        throw new HandlerError({
          status: 404,
          message: "User not found",
        });
      }
      return row;
    },
    catch: (err) =>
      err instanceof HandlerError
        ? err
        : new HandlerError({
            status: 500,
            message: "Database query failed",
            cause: err,
          }),
  });

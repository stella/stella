import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Fetches the user's email and current 2FA enrollment state by ID. The
 * lookup is by the caller's own (session-verified) user ID, not scoped to
 * an organization/workspace — there is no cross-tenant data to leak here.
 */
export const getUserEmailAndTwoFactorEnabled = async (
  currentUserId: string,
): Promise<
  Result<{ email: string; twoFactorEnabled: boolean }, HandlerError>
> =>
  await Result.tryPromise({
    try: async () => {
      const rows = await rootDb
        .select({ email: user.email, twoFactorEnabled: user.twoFactorEnabled })
        .from(user)
        .where(eq(user.id, currentUserId))
        .limit(1);
      const row = rows.at(0);
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

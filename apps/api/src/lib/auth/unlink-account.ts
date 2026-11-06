import { APIError } from "@better-auth/core/error";
import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";
import * as v from "valibot";

import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";

import { account } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  createAuditRecorder,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";
import { lockAccountRow } from "@/api/lib/db/account-row";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const unlinkBody = v.object({
  accountId: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DEFAULT_VARCHAR_MAX_LENGTH),
  ),
  otp: v.pipe(v.string(), v.maxLength(6), v.regex(/^\d{6}$/u)),
});

type UnlinkAccountOptions = {
  session: { user: { id: string; email: string } } | null;
  body: unknown;
  request?: Request | undefined;
};

type UnlinkAccountDependencies = {
  database: {
    transaction: <T>(run: (tx: Transaction) => Promise<T>) => Promise<T>;
  };
  verifyConfirmation: typeof verifyConfirmationOtp;
};

// Auth accounts precede organization membership. Every query is scoped to
// the authoritative session user, including the final deletion.
export const createConfirmedAccountUnlinker =
  ({ database, verifyConfirmation }: UnlinkAccountDependencies) =>
  async ({
    session,
    body,
    request,
  }: UnlinkAccountOptions): Promise<Result<void, APIError>> => {
    if (!session) {
      return Result.err(
        new APIError("UNAUTHORIZED", { message: "Unauthorized" }),
      );
    }
    const parsed = v.safeParse(unlinkBody, body);
    if (!parsed.success) {
      return Result.err(
        new APIError("BAD_REQUEST", {
          message: "Account and verification code required",
        }),
      );
    }
    const confirmation = await verifyConfirmation({
      purpose: "unlink-account",
      email: session.user.email,
      code: parsed.output.otp,
    });
    if (Result.isError(confirmation)) {
      return Result.err(
        new APIError(
          confirmation.error.status >= 500
            ? "INTERNAL_SERVER_ERROR"
            : "BAD_REQUEST",
          { message: "Could not confirm sign-in method removal" },
        ),
      );
    }
    // Burn the code before this transaction so a refused removal cannot restore it.
    const removed = await Result.tryPromise({
      try: async () =>
        await withAggregateTransaction(database, async (tx) => {
          const userId = brandPersistedUserId(session.user.id);
          await lockAccountRow(tx, userId);
          const ownedAccount = and(
            eq(account.userId, session.user.id),
            eq(account.id, parsed.output.accountId),
          );
          const target = await tx
            .select({ id: account.id })
            .from(account)
            .where(ownedAccount)
            .limit(1);
          if (target.length === 0) {
            return Result.err(
              new APIError("BAD_REQUEST", {
                code: "ACCOUNT_NOT_FOUND",
                message: "Account not found",
              }),
            );
          }
          // Keep Better Auth's linked-account set nonempty. A stored row does
          // not prove its provider is configured or its credential has a password;
          // email-code sign-in is a separate deployment capability.
          const remaining = await tx
            .select({ id: account.id })
            .from(account)
            .where(
              and(
                eq(account.userId, session.user.id),
                ne(account.id, parsed.output.accountId),
              ),
            )
            .limit(1);
          if (remaining.length === 0) {
            return Result.err(
              new APIError("BAD_REQUEST", {
                code: "FAILED_TO_UNLINK_LAST_ACCOUNT",
                message: "Keep one linked account",
              }),
            );
          }
          await tx.delete(account).where(ownedAccount);
          const event = {
            type: "account.sign_in_method.disconnected",
            resourceId: parsed.output.accountId,
          } as const;
          if (request) {
            await createAuditRecorder({
              account: { userId },
              request,
              server: null,
            })(tx, event);
          } else {
            await createBackgroundAuditRecorder({ account: { userId } })(
              tx,
              event,
            );
          }
          return Result.ok(undefined);
        }),
      catch: (cause) =>
        new APIError("INTERNAL_SERVER_ERROR", {
          message: "Could not remove sign-in method",
          cause,
        }),
    });
    return removed.andThen((result) => result);
  };

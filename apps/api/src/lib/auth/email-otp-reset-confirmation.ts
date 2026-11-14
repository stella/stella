import { APIError } from "@better-auth/core/error";
import type { AuthContext, Verification } from "better-auth";
import { Result } from "better-result";
import { timingSafeEqual } from "node:crypto";

import { AUTH_ACCESS_RESET_ERROR_CODE } from "@stll/auth-model";
import { sha256Bytes } from "@stll/sha256/node";

import { normalizeEmail } from "@/api/lib/email/normalized-email";
import { isRecord } from "@/api/lib/type-guards";

export const EMAIL_OTP_ALLOWED_ATTEMPTS = 3;
const EMAIL_OTP_SIGN_IN_PATH = "/sign-in/email-otp";

type EmailOtpResetConfirmationOptions = {
  path: string;
  body: unknown;
  adapter: Pick<AuthContext["adapter"], "findMany">;
  internalAdapter: Pick<AuthContext["internalAdapter"], "findUserByEmail">;
};

// This reads Better Auth's plain OTP storage without consuming proof or attempts.
// Keep its attempt budget shared with the configured emailOTP plugin.
export const requireEmailOtpResetConfirmation = async ({
  path,
  body,
  internalAdapter,
  adapter,
}: EmailOtpResetConfirmationOptions) => {
  if (path !== EMAIL_OTP_SIGN_IN_PATH || !isRecord(body)) {
    return Result.ok(undefined);
  }
  if (body["confirmReset"] === true) {
    return Result.ok(undefined);
  }
  const rawEmail = body["email"];
  const otp = body["otp"];
  if (typeof rawEmail !== "string" || typeof otp !== "string") {
    return Result.ok(undefined);
  }
  const email = normalizeEmail(rawEmail);

  const verifications = await adapter.findMany<Verification>({
    model: "verification",
    where: [{ field: "identifier", value: `sign-in-otp-${email}` }],
    sortBy: { field: "createdAt", direction: "desc" },
    limit: 1,
  });
  const verification = verifications.at(0);
  if (!verification || verification.expiresAt < new Date()) {
    return Result.ok(undefined);
  }
  const separator = verification.value.lastIndexOf(":");
  const storedOtp =
    separator === -1
      ? verification.value
      : verification.value.slice(0, separator);
  const attempts =
    separator === -1 ? "0" : verification.value.slice(separator + 1);
  if (Number.parseInt(attempts || "0", 10) >= EMAIL_OTP_ALLOWED_ATTEMPTS) {
    return Result.ok(undefined);
  }
  if (!timingSafeEqual(sha256Bytes(otp), sha256Bytes(storedOtp))) {
    return Result.ok(undefined);
  }

  const account = await internalAdapter.findUserByEmail(email, {
    includeAccounts: true,
  });
  if (!account || account.user.emailVerified || account.accounts.length === 0) {
    return Result.ok(undefined);
  }
  return Result.err(
    new APIError("CONFLICT", {
      code: AUTH_ACCESS_RESET_ERROR_CODE,
      message: "Confirm resetting account access to sign in with this code.",
      providers: [
        ...new Set(account.accounts.map(({ providerId }) => providerId)),
      ],
    }),
  );
};

/**
 * The email whose account an email-code sign-in is promoting to verified, when
 * this user update is that promotion. Better Auth removes the account's linked
 * providers and sessions before it writes the promotion and creates the new
 * session after it, so credentials swept at this point cannot outlive the reset
 * through a displaced sign-in.
 */
export const emailOtpPromotionEmail = (
  update: Record<string, unknown>,
  context: { path?: string | undefined; body?: unknown } | null | undefined,
): string | undefined => {
  if (
    context?.path !== EMAIL_OTP_SIGN_IN_PATH ||
    update["emailVerified"] !== true ||
    !isRecord(context.body)
  ) {
    return undefined;
  }
  const email = context.body["email"];
  return typeof email === "string" ? normalizeEmail(email) : undefined;
};

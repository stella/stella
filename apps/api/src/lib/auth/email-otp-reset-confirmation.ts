import { APIError } from "@better-auth/core/error";
import type { AuthContext, Verification } from "better-auth";
import { Result } from "better-result";
import { timingSafeEqual } from "node:crypto";

import { AUTH_ACCESS_RESET_ERROR_CODE } from "@stll/auth-model";
import { sha256Bytes } from "@stll/sha256/node";

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
  const email = body["email"];
  const otp = body["otp"];
  if (typeof email !== "string" || typeof otp !== "string") {
    return Result.ok(undefined);
  }

  const verifications = await adapter.findMany<Verification>({
    model: "verification",
    where: [
      { field: "identifier", value: `sign-in-otp-${email.toLowerCase()}` },
    ],
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

  const account = await internalAdapter.findUserByEmail(email.toLowerCase(), {
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

import { Result } from "better-result";

import { env } from "@/api/env";
import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { stashDevOtp } from "@/api/lib/dev-otp-store";
import { sendOTPEmail } from "@/api/lib/email";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { extractLangFromRequest } from "@/api/lib/locale";
import { getUserEmailAndTwoFactorEnabled } from "@/api/lib/two-factor";

const config = {
  mcp: { type: "internal", reason: "account_lifecycle" },
} satisfies SessionHandlerConfig;

const twoFactorSendManageOtp = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const currentUserId = ctx.user.id;
    const request = ctx.request;

    // 1. Fetch user details; refuse if 2FA is not currently enabled — there
    // is nothing to gate a management-confirmation code for.
    const { email: emailStr, twoFactorEnabled } = yield* Result.await(
      getUserEmailAndTwoFactorEnabled(currentUserId),
    );

    if (!twoFactorEnabled) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Two-factor authentication is not enabled",
        }),
      );
    }

    // 2. Generate and store a cryptographically secure 6-digit OTP
    const otp = yield* Result.await(
      createConfirmationOtp({ purpose: "two-factor-manage", email: emailStr }),
    );

    // 3. Send email (log + stash to the dev OTP store in development)
    const lang = extractLangFromRequest(request);
    const emailResult = await Result.tryPromise({
      try: async () =>
        await sendOTPEmail({
          email: emailStr,
          otp,
          type: "two-factor-manage",
          lang,
        }),
      catch: (err) => err,
    });

    if (env.isDev) {
      // eslint-disable-next-line no-console -- Local dev fallback prints OTPs when SMTP is unavailable.
      console.log(
        `\n\x1b[33m[DEV] OTP for ${emailStr}: ${otp} (type: two-factor-manage)\x1b[0m\n`,
      );
      stashDevOtp(emailStr, otp);
      if (emailResult.isErr()) {
        const message =
          emailResult.error instanceof Error
            ? emailResult.error.message
            : String(emailResult.error);
        // eslint-disable-next-line no-console -- Local dev fallback should expose SMTP delivery failures.
        console.warn(`[DEV] Failed to send email via SMTP: ${message}`);
      }
    } else if (emailResult.isErr()) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to send verification email",
          cause: emailResult.error,
        }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default twoFactorSendManageOtp;

import { Result } from "better-result";

import { env } from "@/api/env";
import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import {
  checkUserOrganizationOwnership,
  createDeleteAccountOtp,
  getUserEmail,
} from "@/api/lib/delete-account";
import { sendOTPEmail } from "@/api/lib/email";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { extractLangFromRequest } from "@/api/lib/locale";

const config = {};

const deleteAccountSendOtp = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const currentUserId = ctx.user.id;
    const request = ctx.request;

    // 1. Fetch user details to get email
    const emailStr = yield* Result.await(getUserEmail(currentUserId));

    // 2. Check if the user is the sole owner of any organization
    const ownershipCheck = yield* Result.await(
      checkUserOrganizationOwnership(currentUserId),
    );

    if (ownershipCheck.isSoleOwner) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Cannot delete account because you are the sole owner of organization "${ownershipCheck.orgName}". Please transfer ownership or delete the organization first.`,
        }),
      );
    }

    // 3. Generate a cryptographically secure 6-digit OTP
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    const [val] = array;
    if (val === undefined) {
      throw new Error("Failed to generate random value");
    }
    const otp = (100_000 + (val % 900_000)).toString();

    // 4. Store OTP in verification table
    yield* Result.await(createDeleteAccountOtp(emailStr, otp));

    // 5. Send email (log to console and fallback in development)
    const lang = extractLangFromRequest(request);
    const emailResult = await Result.tryPromise({
      try: async () =>
        await sendOTPEmail({
          email: emailStr,
          otp,
          type: "delete-account",
          lang,
        }),
      catch: (err) => err,
    });

    if (env.isDev) {
      // eslint-disable-next-line no-console
      console.log(
        `\n\x1b[33m[DEV] OTP for ${emailStr}: ${otp} (type: delete-account)\x1b[0m\n`,
      );
      if (emailResult.isErr()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[DEV] Failed to send email via SMTP: ${(emailResult.error as Error).message}`,
        );
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

export default deleteAccountSendOtp;

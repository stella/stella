import { Result } from "better-result";

import { errorOutputLogger } from "@stll/errors";

import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import { stashDevOtp } from "@/api/lib/dev-otp-store";
import { sendOTPEmail } from "@/api/lib/email/email";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { extractLangFromRequest } from "@/api/lib/locale";
import { isLocalDevOpen } from "@/api/runtime-mode";

type SendManageOtpOptions = {
  purpose: "two-factor-manage" | "unlink-account";
  email: string;
  request: Request | undefined;
};

export const sendManageOtp = async ({
  purpose,
  email,
  request,
}: SendManageOtpOptions): Promise<Result<{ success: true }, HandlerError>> => {
  const generated = await createConfirmationOtp({ purpose, email });
  if (Result.isError(generated)) {
    return Result.err(generated.error);
  }
  const otp = generated.value;
  const lang = extractLangFromRequest(request);
  const emailResult = await Result.tryPromise({
    try: async () =>
      await sendOTPEmail({
        email,
        otp,
        type: purpose === "two-factor-manage" ? purpose : "email-verification",
        lang,
      }),
    catch: (err) => err,
  });

  if (isLocalDevOpen()) {
    // oxlint-disable-next-line no-console -- Local dev fallback prints OTPs when SMTP is unavailable.
    console.log(
      `\n\x1b[33m[DEV] OTP for ${email}: ${otp} (type: ${purpose})\x1b[0m\n`,
    );
    stashDevOtp(email, otp);
    if (emailResult.isErr()) {
      errorOutputLogger.log(
        "warn",
        "[DEV] Failed to send email via SMTP:",
        emailResult.error,
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
};

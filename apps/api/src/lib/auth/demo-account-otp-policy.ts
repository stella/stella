export const DEMO_ACCOUNT_OTP_WARNING_EVENT =
  "auth.demo_credential_override_skipped";

export type DemoAccountOtpArgs = {
  email: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
};

type ResolveDemoAccountOtpOptions = DemoAccountOtpArgs & {
  demoEmail: string | undefined;
  demoOtp: string | undefined;
  warn: () => void;
};

/**
 * Fixed-OTP override for the single designated demo account
 * (`DEMO_ACCOUNT_EMAIL` + `DEMO_ACCOUNT_OTP`), for external evaluations that
 * need working credentials without inbox access. Deliberately narrow: both
 * variables must be set, only the exact configured address matches, and only
 * the `sign-in` type is overridden, so password-reset and change-email flows
 * can never ride on the fixed code. The returned code is stored and verified
 * like any generated OTP, so the attempt limit and expiry keep applying.
 */
export const resolveDemoAccountOtp = ({
  email,
  type,
  demoEmail,
  demoOtp,
  warn,
}: ResolveDemoAccountOtpOptions): string | undefined => {
  if (type !== "sign-in" || !demoEmail || !demoOtp) {
    return undefined;
  }
  if (email.trim().toLowerCase() !== demoEmail.trim().toLowerCase()) {
    warn();
    return undefined;
  }
  return demoOtp;
};

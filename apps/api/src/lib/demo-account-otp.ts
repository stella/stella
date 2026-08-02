import { env } from "@/api/env";

type DemoAccountOtpArgs = {
  email: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
};

type ResolveDemoAccountOtpOptions = DemoAccountOtpArgs & {
  demoEmail: string | undefined;
  demoOtp: string | undefined;
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
}: ResolveDemoAccountOtpOptions): string | undefined => {
  if (type !== "sign-in" || !demoEmail || !demoOtp) {
    return undefined;
  }
  if (email.trim().toLowerCase() !== demoEmail) {
    return undefined;
  }
  return demoOtp;
};

/** Env-wired form of {@link resolveDemoAccountOtp}. */
export const getDemoAccountOtpOverride = ({
  email,
  type,
}: DemoAccountOtpArgs): string | undefined =>
  resolveDemoAccountOtp({
    email,
    type,
    demoEmail: env.DEMO_ACCOUNT_EMAIL,
    demoOtp: env.DEMO_ACCOUNT_OTP,
  });

import { env } from "@/api/env";
import {
  DEMO_ACCOUNT_OTP_WARNING_EVENT,
  resolveDemoAccountOtp,
} from "@/api/lib/auth/demo-account-otp-policy";
import type { DemoAccountOtpArgs } from "@/api/lib/auth/demo-account-otp-policy";
import { logger } from "@/api/lib/observability/logger";

let overrideWarningEmitted = false;

export const getDemoAccountOtpOverride = ({
  email,
  type,
}: DemoAccountOtpArgs): string | undefined =>
  resolveDemoAccountOtp({
    email,
    type,
    demoEmail: env.DEMO_ACCOUNT_EMAIL,
    demoOtp: env.DEMO_ACCOUNT_OTP,
    warn: () => {
      if (overrideWarningEmitted) {
        return;
      }
      overrideWarningEmitted = true;
      logger.warn(DEMO_ACCOUNT_OTP_WARNING_EVENT);
    },
  });

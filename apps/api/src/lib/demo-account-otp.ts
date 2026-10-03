import { Temporal } from "@stll/time";

import { env } from "@/api/env";
import {
  DEMO_ACCOUNT_OTP_ROTATION_WARNING_EVENT,
  resolveDemoAccountOtp,
} from "@/api/lib/demo-account-otp-policy";
import type { DemoAccountOtpArgs } from "@/api/lib/demo-account-otp-policy";
import { logger } from "@/api/lib/observability/logger";
import { runtimeMode } from "@/api/runtime-mode";

export const getDemoAccountOtpOverride = ({
  email,
  type,
}: DemoAccountOtpArgs): string | undefined =>
  resolveDemoAccountOtp({
    email,
    type,
    demoEmail: env.DEMO_ACCOUNT_EMAIL,
    demoOtp: env.DEMO_ACCOUNT_OTP,
    rotatedAt: env.DEMO_ACCOUNT_OTP_ROTATED_AT,
    runtimeMode: runtimeMode(),
    now: Temporal.Now.instant().epochMilliseconds,
    warn: ({ reason }) =>
      logger.warn(DEMO_ACCOUNT_OTP_ROTATION_WARNING_EVENT, { reason }),
  });

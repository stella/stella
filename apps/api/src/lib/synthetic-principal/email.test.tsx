import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { env } from "@/api/env";
import {
  sendOTPEmail,
  sendReportExportStatusEmail,
} from "@/api/lib/email/email";
import { createTestState } from "@/api/tests/helpers/test-state";

import { SYNTHETIC_PRINCIPAL } from "./constants";

const state = createTestState({ file: import.meta.path, config: env });

test("the monitoring address never requires a delivery transport", async () => {
  state.setConfig("EMAIL_PROVIDER", undefined);
  const otp = { otp: "000000", type: "sign-in", lang: "en" } as const;
  await sendOTPEmail({ ...otp, email: SYNTHETIC_PRINCIPAL.user.email });
  await sendReportExportStatusEmail({
    appUrl: "https://my.stll.app",
    email: SYNTHETIC_PRINCIPAL.user.email,
    lang: "en",
    status: "completed",
  });
  expect(
    await rejectionOf(sendOTPEmail({ ...otp, email: "member@example.test" })),
  ).toMatchObject({
    message: "EMAIL_PROVIDER is required before sending transactional email",
  });
});

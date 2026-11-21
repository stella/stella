import { expect, test } from "bun:test";
import * as v from "valibot";

import { SIGN_IN_MODE } from "@/components/auth/sign-in-mode";

import { otpSearchSchema, otpSessionNavigation } from "./-otp.logic";

for (const mode of Object.values(SIGN_IN_MODE)) {
  for (const hasSession of [true, false]) {
    const session = hasSession ? "present" : "absent";
    test(`${mode} with a ${session} session preserves the OTP flow decision`, () => {
      const search = v.parse(otpSearchSchema, {
        mode,
        email: "reader@example.test",
        redirectTo: "/account",
      });
      const navigation = otpSessionNavigation({ ...search, session });
      if (mode === SIGN_IN_MODE.signIn && session === "present") {
        expect(navigation).toEqual({
          to: "/auth/organization",
          search: { redirectTo: "/account" },
          replace: true,
        });
        return;
      }
      expect(navigation).toBeUndefined();
    });
  }
}

test("OTP links without a mode retain ordinary sign-in behavior", () => {
  const search = v.parse(otpSearchSchema, {
    email: "reader@example.test",
    redirectTo: "/account",
  });
  expect(search.mode).toBe(SIGN_IN_MODE.signIn);
  expect(otpSessionNavigation({ ...search, session: "present" })).toEqual({
    to: "/auth/organization",
    search: { redirectTo: "/account" },
    replace: true,
  });
});

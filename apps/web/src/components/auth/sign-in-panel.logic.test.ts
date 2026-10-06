import { describe, expect, test } from "bun:test";

import type { AuthCapabilities } from "@/components/auth/sign-in-panel.logic";
import { resolveSignInOptions } from "@/components/auth/sign-in-panel.logic";

const authCapabilities = {
  emailOtp: true,
  localPassword: false,
  bootstrap: false,
  social: {
    google: false,
    microsoft: false,
  },
} as const satisfies AuthCapabilities;

describe("sign-in panel options", () => {
  test("hides social options and the email separator when no social provider is configured", () => {
    expect(
      resolveSignInOptions({
        authCapabilities,
        socialProviderFlags: {
          google: true,
          microsoft: true,
        },
      }),
    ).toMatchObject({
      showGoogle: false,
      showMicrosoft: false,
      showSocialProviders: false,
      hasAboveEmailOptions: false,
    });
  });

  test("shows the email separator when a configured social provider is enabled for the client", () => {
    expect(
      resolveSignInOptions({
        authCapabilities: {
          ...authCapabilities,
          social: {
            ...authCapabilities.social,
            google: true,
          },
        },
        socialProviderFlags: {
          google: true,
          microsoft: false,
        },
      }),
    ).toMatchObject({
      showGoogle: true,
      showSocialProviders: true,
      hasAboveEmailOptions: true,
    });
  });

  test.each([
    [
      { emailOtp: true, localPassword: false, bootstrap: false },
      false,
      "offered",
    ],
    [
      { emailOtp: false, localPassword: false, bootstrap: true },
      false,
      "offered",
    ],
    [
      { emailOtp: false, localPassword: true, bootstrap: false },
      true,
      "offered",
    ],
    [
      { emailOtp: false, localPassword: true, bootstrap: false },
      false,
      "not_offered",
    ],
  ] as const)(
    "account creation for %o with a social provider %p is %s",
    (capabilities, google, expected) => {
      expect(
        resolveSignInOptions({
          authCapabilities: {
            ...capabilities,
            social: { google, microsoft: false },
          },
          socialProviderFlags: { google: true, microsoft: false },
        }).accountCreation,
      ).toBe(expected);
    },
  );
});

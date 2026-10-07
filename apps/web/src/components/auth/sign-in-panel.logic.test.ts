import { describe, expect, test } from "bun:test";

import type { AuthCapabilities } from "@/components/auth/sign-in-panel.logic";
import {
  resolveLastUsedSignInMethod,
  resolveSignInOptions,
  SIGN_IN_METHOD,
  signInMethodVariant,
} from "@/components/auth/sign-in-panel.logic";

const authCapabilities = {
  emailOtp: true,
  localPassword: false,
  reviewPasswordSignIn: false,
  bootstrap: false,
  social: {
    google: false,
    microsoft: false,
  },
} as const satisfies AuthCapabilities;

describe("restricted password sign-in option", () => {
  test.each([
    { review: false, local: false, bootstrap: false, shown: false },
    { review: true, local: false, bootstrap: false, shown: true },
    // The full password form already covers it.
    { review: true, local: true, bootstrap: false, shown: false },
    { review: true, local: false, bootstrap: true, shown: false },
  ])(
    "offers the quiet password option only on its own capability: %o",
    ({ review, local, bootstrap, shown }) => {
      const options = resolveSignInOptions({
        authCapabilities: {
          ...authCapabilities,
          reviewPasswordSignIn: review,
          localPassword: local,
          bootstrap,
        },
        socialProviderFlags: { google: false, microsoft: false },
      });
      expect(options.showReviewPasswordSignIn).toBe(shown);
    },
  );
});

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
            reviewPasswordSignIn: false,
            social: { google, microsoft: false },
          },
          socialProviderFlags: { google: true, microsoft: false },
        }).accountCreation,
      ).toBe(expected);
    },
  );
});

const everyOption = resolveSignInOptions({
  authCapabilities: {
    emailOtp: true,
    localPassword: true,
    reviewPasswordSignIn: false,
    bootstrap: false,
    social: { google: true, microsoft: true },
  },
  socialProviderFlags: { google: true, microsoft: true },
});

describe("last-used sign-in method", () => {
  test.each(Object.values(SIGN_IN_METHOD))(
    "keeps %s when the page offers it",
    (method) => {
      expect(
        resolveLastUsedSignInMethod({ stored: method, options: everyOption }),
      ).toBe(method);
    },
  );

  test.each([null, "", "passkey", "constructor", "GOOGLE"])(
    "ignores a missing or unknown stored value (%p)",
    (stored) => {
      expect(
        resolveLastUsedSignInMethod({ stored, options: everyOption }),
      ).toBeNull();
    },
  );

  test("ignores a method this deployment no longer offers", () => {
    const emailOnly = resolveSignInOptions({
      authCapabilities,
      socialProviderFlags: { google: true, microsoft: true },
    });
    for (const method of [
      SIGN_IN_METHOD.google,
      SIGN_IN_METHOD.microsoft,
      SIGN_IN_METHOD.password,
    ]) {
      expect(
        resolveLastUsedSignInMethod({ stored: method, options: emailOnly }),
      ).toBeNull();
    }
  });

  test("does not mark the first-account form as the password sign-in", () => {
    const bootstrap = resolveSignInOptions({
      authCapabilities: {
        ...authCapabilities,
        localPassword: true,
        reviewPasswordSignIn: false,
        bootstrap: true,
      },
      socialProviderFlags: { google: false, microsoft: false },
    });
    expect(
      resolveLastUsedSignInMethod({
        stored: SIGN_IN_METHOD.password,
        options: bootstrap,
      }),
    ).toBeNull();
  });

  test("fills only the last-used method and keeps normal emphasis without one", () => {
    expect(
      signInMethodVariant({
        method: SIGN_IN_METHOD.google,
        lastUsed: SIGN_IN_METHOD.google,
        fallback: "outline",
      }),
    ).toBe("default");
    expect(
      signInMethodVariant({
        method: SIGN_IN_METHOD.emailOtp,
        lastUsed: SIGN_IN_METHOD.google,
        fallback: "default",
      }),
    ).toBe("outline");
    expect(
      signInMethodVariant({
        method: SIGN_IN_METHOD.emailOtp,
        lastUsed: null,
        fallback: "default",
      }),
    ).toBe("default");
    expect(
      signInMethodVariant({
        method: SIGN_IN_METHOD.google,
        lastUsed: null,
        fallback: "outline",
      }),
    ).toBe("outline");
  });
});

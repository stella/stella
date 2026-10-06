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
});

const everyOption = resolveSignInOptions({
  authCapabilities: {
    emailOtp: true,
    localPassword: true,
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

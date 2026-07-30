import { describe, expect, mock, test } from "bun:test";

import {
  STELLA_MOBILE_AUTH_CHALLENGE_PARAM,
  STELLA_MOBILE_AUTH_CODE_PARAM,
} from "@stll/api-contract";

import {
  mobileAuthChallengeForVerifier,
  protectMobileCallbackLocation,
  redeemMobileSession,
} from "@/api/lib/mobile-auth-session";

const VERIFIER = "a".repeat(64);
const CHALLENGE = mobileAuthChallengeForVerifier(VERIFIER);
const CODE = "b".repeat(43);

describe("installation-bound mobile OAuth callback", () => {
  test("replaces the raw session cookie with a verifier-bound one-time code", async () => {
    const createGrant = mock(async () => await Promise.resolve(CODE));
    const callback = new URL("stella:///");
    callback.searchParams.set(STELLA_MOBILE_AUTH_CHALLENGE_PARAM, CHALLENGE);
    callback.searchParams.set("cookie", "better-auth.session_token=secret");

    const protectedLocation = await protectMobileCallbackLocation({
      createGrant,
      location: callback.toString(),
    });

    expect(createGrant).toHaveBeenCalledWith({
      challenge: CHALLENGE,
      cookie: "better-auth.session_token=secret",
    });
    expect(protectedLocation).toBeDefined();
    const protectedUrl = new URL(protectedLocation ?? "stella:///");
    expect(protectedUrl.searchParams.get("cookie")).toBeNull();
    expect(
      protectedUrl.searchParams.get(STELLA_MOBILE_AUTH_CHALLENGE_PARAM),
    ).toBeNull();
    expect(protectedUrl.searchParams.get(STELLA_MOBILE_AUTH_CODE_PARAM)).toBe(
      CODE,
    );
  });

  test("fails closed for an older callback that has no installation challenge", async () => {
    const createGrant = mock(async () => await Promise.resolve(CODE));
    const protectedLocation = await protectMobileCallbackLocation({
      createGrant,
      location: "stella:///?cookie=better-auth.session_token%3Dsecret",
    });

    expect(createGrant).not.toHaveBeenCalled();
    const protectedUrl = new URL(protectedLocation ?? "stella:///");
    expect(protectedUrl.searchParams.get("cookie")).toBeNull();
    expect(protectedUrl.searchParams.get("error")).toBe(
      "mobile_callback_unbound",
    );
  });

  test("protects Expo Go callbacks with the same verifier-bound bridge", async () => {
    const createGrant = mock(async () => await Promise.resolve(CODE));
    const callback = new URL("exp://192.168.1.20:8081/--/");
    callback.searchParams.set(STELLA_MOBILE_AUTH_CHALLENGE_PARAM, CHALLENGE);
    callback.searchParams.set("cookie", "better-auth.session_token=secret");

    const protectedLocation = await protectMobileCallbackLocation({
      createGrant,
      location: callback.toString(),
    });

    expect(createGrant).toHaveBeenCalledWith({
      challenge: CHALLENGE,
      cookie: "better-auth.session_token=secret",
    });
    const protectedUrl = new URL(protectedLocation ?? "exp://invalid/");
    expect(protectedUrl.protocol).toBe("exp:");
    expect(protectedUrl.host).toBe("192.168.1.20:8081");
    expect(protectedUrl.searchParams.get("cookie")).toBeNull();
    expect(protectedUrl.searchParams.get(STELLA_MOBILE_AUTH_CODE_PARAM)).toBe(
      CODE,
    );
  });

  test("does not rewrite browser redirects", async () => {
    const createGrant = mock(async () => await Promise.resolve(CODE));
    expect(
      await protectMobileCallbackLocation({
        createGrant,
        location: "https://my.stll.app/?cookie=browser-cookie",
      }),
    ).toBeUndefined();
    expect(createGrant).not.toHaveBeenCalled();
  });

  test("a wrong verifier cannot consume an intercepted code", async () => {
    const consumeVerificationValue = mock(
      async () =>
        await Promise.reject(
          new Error("wrong verifier must not consume the grant"),
        ),
    );
    const cookie = await redeemMobileSession({
      code: CODE,
      verifier: "c".repeat(64),
      store: {
        consumeVerificationValue,
        findVerificationValue: async () =>
          await Promise.resolve({
            expiresAt: new Date(Date.now() + 60_000),
            value: JSON.stringify({
              challenge: CHALLENGE,
              cookie: "better-auth.session_token=secret",
            }),
          }),
      },
    });

    expect(cookie).toBeUndefined();
    expect(consumeVerificationValue).not.toHaveBeenCalled();
  });

  test("the verifier redeems the session cookie exactly once", async () => {
    const stored = {
      expiresAt: new Date(Date.now() + 60_000),
      value: JSON.stringify({
        challenge: CHALLENGE,
        cookie: "better-auth.session_token=secret",
      }),
    };
    let available = true;
    const store = {
      findVerificationValue: async () =>
        await Promise.resolve(available ? stored : null),
      consumeVerificationValue: async () => {
        if (!available) {
          return await Promise.resolve(null);
        }
        available = false;
        return await Promise.resolve(stored);
      },
    };

    expect(
      await redeemMobileSession({ code: CODE, store, verifier: VERIFIER }),
    ).toBe("better-auth.session_token=secret");
    expect(
      await redeemMobileSession({ code: CODE, store, verifier: VERIFIER }),
    ).toBeUndefined();
  });

  test("an expired grant is consumed without returning its session cookie", async () => {
    const stored = {
      expiresAt: new Date(0),
      value: JSON.stringify({
        challenge: CHALLENGE,
        cookie: "better-auth.session_token=secret",
      }),
    };
    const consumeVerificationValue = mock(async () => stored);

    expect(
      await redeemMobileSession({
        code: CODE,
        verifier: VERIFIER,
        store: {
          consumeVerificationValue,
          findVerificationValue: async () => stored,
        },
      }),
    ).toBeUndefined();
    expect(consumeVerificationValue).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, test } from "bun:test";

import { STELLA_MOBILE_AUTH_CHALLENGE_PARAM } from "@stll/api-contract";

import {
  isMobileTwoFactorCallback,
  mobileAuthCallbackFor,
} from "./mobile-auth-callback";

const CHALLENGE = "a".repeat(43);

describe("mobileAuthCallbackFor", () => {
  test("routes an Expo Go callback back to the current development host", () => {
    const callback = new URL(
      mobileAuthCallbackFor({
        challenge: CHALLENGE,
        runtimeLinkingUrl: "exp://192.168.1.20:8081/--/sign-in?stale=1",
      }),
    );

    expect(callback.protocol).toBe("exp:");
    expect(callback.host).toBe("192.168.1.20:8081");
    expect(callback.pathname).toBe("/--/");
    expect(callback.searchParams.get("stale")).toBeNull();
    expect(callback.searchParams.get(STELLA_MOBILE_AUTH_CHALLENGE_PARAM)).toBe(
      CHALLENGE,
    );
  });

  test("uses the installed app scheme outside Expo Go", () => {
    expect(
      mobileAuthCallbackFor({
        challenge: CHALLENGE,
        runtimeLinkingUrl: "stella:///sign-in",
      }),
    ).toBe(`stella:///?${STELLA_MOBILE_AUTH_CHALLENGE_PARAM}=${CHALLENGE}`);
  });

  test("does not trust a non-Expo runtime URL as the callback destination", () => {
    expect(
      mobileAuthCallbackFor({
        challenge: CHALLENGE,
        runtimeLinkingUrl: "https://attacker.example/callback",
      }),
    ).toStartWith("stella:///");
  });
});

describe("isMobileTwoFactorCallback", () => {
  test.each([
    "stella:///two-factor?stella_challenge=challenge",
    "exp://192.168.1.4:8081/--/two-factor?stella_challenge=challenge",
  ])("recognizes the installed and Expo Go challenge routes: %s", (url) => {
    expect(isMobileTwoFactorCallback(url)).toBe(true);
  });

  test("rejects a non-challenge callback", () => {
    expect(isMobileTwoFactorCallback("exp://192.168.1.4:8081/--/")).toBe(false);
    expect(
      isMobileTwoFactorCallback("https://app.example.com/two-factor"),
    ).toBe(false);
  });
});

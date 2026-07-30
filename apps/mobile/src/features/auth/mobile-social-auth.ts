import { getSetCookie, storageAdapter } from "@better-auth/expo/client";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import {
  buildApiUrl,
  STELLA_AUTH_COOKIE_PREFIXES,
  STELLA_MOBILE_AUTH_CODE_PARAM,
  STELLA_MOBILE_AUTH_EXCHANGE_PATH,
} from "@stll/api-contract";

import { env } from "@/env";
import {
  isTwoFactorRedirect,
  MobileAuthError,
  toMobileAuthError,
} from "@/features/auth/auth-result";
import {
  isMobileTwoFactorCallback,
  mobileAuthCallbackFor,
} from "@/features/auth/mobile-auth-callback";
import { authClient } from "@/lib/auth-client";
import { mobileAuthStoragePrefix } from "@/lib/auth-storage";

export type MobileSocialProvider = "google" | "microsoft";
export type MobileSocialSignInResult = "complete" | "twoFactor";

const storage = storageAdapter(SecureStore);
const cookieStorageKey = `${mobileAuthStoragePrefix(env.API_URL)}_cookie`;

const storedOAuthState = (): string | undefined => {
  const raw = storage.getItem(cookieStorageKey);
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    for (const prefix of STELLA_AUTH_COOKIE_PREFIXES) {
      for (const name of [
        `${prefix}.oauth_state`,
        `__Secure-${prefix}.oauth_state`,
      ]) {
        if (name in parsed) {
          const stored: unknown = Reflect.get(parsed, name);
          const candidate =
            typeof stored === "object" && stored !== null && "value" in stored
              ? stored.value
              : undefined;
          if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
          }
        }
      }
    }
  } catch {
    // A corrupt/torn cache is treated as absent. The proxy can still bind the
    // browser callback from the provider's signed state parameter.
  }
  return undefined;
};

const createVerifier = (): string =>
  `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replaceAll("-", "");

const challengeFor = async (verifier: string): Promise<string> => {
  const base64 = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_");
  // A SHA-256 digest is 32 bytes, so its base64 form has exactly one padding
  // character. Avoid a variable-width suffix regex on this security boundary.
  return base64Url.endsWith("=") ? base64Url.slice(0, -1) : base64Url;
};

const exchangeSession = async ({
  code,
  verifier,
}: {
  code: string;
  verifier: string;
}): Promise<void> => {
  const response = await fetch(
    buildApiUrl(env.API_URL, STELLA_MOBILE_AUTH_EXCHANGE_PATH),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier }),
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    throw new MobileAuthError({
      message: "The mobile sign-in could not be verified. Please try again.",
    });
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("cookie" in body) ||
    typeof body.cookie !== "string" ||
    body.cookie.length === 0
  ) {
    throw new MobileAuthError({
      message: "The mobile sign-in returned an invalid session.",
    });
  }

  const previous = storage.getItem(cookieStorageKey);
  await storage.setItem(
    cookieStorageKey,
    getSetCookie(body.cookie, previous ?? undefined),
  );
};

/**
 * Completes social OAuth without putting a session cookie in a claimable
 * private-use callback. The deep link carries a one-time code; only this app
 * installation holds the verifier needed to redeem it over HTTPS.
 */
export const signInSocialOnMobile = async (
  provider: MobileSocialProvider,
): Promise<MobileSocialSignInResult> => {
  if (Platform.OS === "web") {
    const result = await authClient.signIn.social({
      callbackURL: "/",
      errorCallbackURL: "/sign-in",
      provider,
    });
    if (result.error) {
      throw toMobileAuthError(result.error, "Social sign-in failed.");
    }
    return isTwoFactorRedirect(result.data) ? "twoFactor" : "complete";
  }

  const verifier = createVerifier();
  const callbackURL = mobileAuthCallbackFor({
    challenge: await challengeFor(verifier),
    runtimeLinkingUrl: Linking.getLinkingURL(),
  });
  const started = await authClient.signIn.social({
    callbackURL,
    disableRedirect: true,
    errorCallbackURL: callbackURL,
    provider,
  });
  if (started.error) {
    throw toMobileAuthError(started.error, "Social sign-in failed.");
  }
  const authorizationURL = started.data.url;
  if (typeof authorizationURL !== "string" || authorizationURL.length === 0) {
    throw new MobileAuthError({
      message: "The identity provider did not return a sign-in URL.",
    });
  }

  const proxy = new URL(
    buildApiUrl(env.API_URL, "/api/auth/expo-authorization-proxy"),
  );
  proxy.searchParams.set("authorizationURL", authorizationURL);
  const oauthState = storedOAuthState();
  if (oauthState !== undefined) {
    proxy.searchParams.set("oauthState", oauthState);
  }

  const browserResult = await WebBrowser.openAuthSessionAsync(
    proxy.toString(),
    callbackURL,
  );
  if (browserResult.type !== "success") {
    throw new MobileAuthError({ message: "Social sign-in was cancelled." });
  }

  const callback = new URL(browserResult.url);
  const providerError = callback.searchParams.get("error");
  if (providerError !== null) {
    throw new MobileAuthError({
      message:
        callback.searchParams.get("error_description") ??
        "The identity provider rejected the sign-in.",
    });
  }
  const code = callback.searchParams.get(STELLA_MOBILE_AUTH_CODE_PARAM);
  if (code === null) {
    throw new MobileAuthError({
      message: "The mobile sign-in did not return a verification code.",
    });
  }
  await exchangeSession({ code, verifier });
  return isMobileTwoFactorCallback(callback.toString())
    ? "twoFactor"
    : "complete";
};

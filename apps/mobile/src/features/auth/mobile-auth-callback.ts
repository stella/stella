import {
  STELLA_MOBILE_AUTH_CHALLENGE_PARAM,
  STELLA_MOBILE_ORIGIN,
  STELLA_MOBILE_SCHEME,
} from "@stll/api-contract";

const parseRuntimeUrl = (value: string | null): URL | undefined => {
  if (value === null) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * Build the callback for the runtime that is actually hosting the app. Expo Go
 * cannot claim the installed app's private scheme, so its current `exp://`
 * host must receive the callback through Expo Router's `/--/` boundary.
 */
export const mobileAuthCallbackFor = ({
  challenge,
  runtimeLinkingUrl,
}: {
  challenge: string;
  runtimeLinkingUrl: string | null;
}): string => {
  const runtime = parseRuntimeUrl(runtimeLinkingUrl);
  const callback =
    runtime?.protocol === "exp:" && runtime.host.length > 0
      ? runtime
      : new URL("/", STELLA_MOBILE_ORIGIN);

  if (callback.protocol === "exp:") {
    callback.pathname = "/--/";
  }
  callback.search = "";
  callback.hash = "";
  callback.searchParams.set(STELLA_MOBILE_AUTH_CHALLENGE_PARAM, challenge);
  return callback.toString();
};

export const isMobileTwoFactorCallback = (callbackUrl: string): boolean => {
  const callback = parseRuntimeUrl(callbackUrl);
  return (
    (callback?.protocol === `${STELLA_MOBILE_SCHEME}:` &&
      callback.pathname === "/two-factor") ||
    (callback?.protocol === "exp:" && callback.pathname === "/--/two-factor")
  );
};

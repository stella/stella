import { STELLA_MOBILE_ORIGIN } from "@stll/api-contract";

export const DEV_INSPECTOR_ORIGINS = [
  "http://localhost:6274",
  "http://127.0.0.1:6274",
] as const;

const EXPO_DEV_ORIGINS = ["exp://", "exp://**"] as const;
export const DEFAULT_EXPO_WEB_ORIGIN = "http://localhost:8081";

/** Custom-scheme origins accepted from the native client. */
export const mobileAppOrigins = (isDev: boolean) => {
  if (!isDev) {
    return [STELLA_MOBILE_ORIGIN];
  }
  return [STELLA_MOBILE_ORIGIN, ...EXPO_DEV_ORIGINS];
};

export const frontendOrigins = ({
  frontendUrl,
  isDev,
}: {
  frontendUrl: string;
  isDev: boolean;
}) => {
  if (!isDev) {
    return [frontendUrl];
  }
  return expandLoopbackOrigin(frontendUrl);
};

/** Browser origins accepted from the Expo web development server. */
export const expoWebOrigins = ({
  expoWebOrigin,
  isDev,
}: {
  expoWebOrigin: string;
  isDev: boolean;
}) => (isDev ? expandLoopbackOrigin(expoWebOrigin) : []);

const expandLoopbackOrigin = (origin: string) => {
  const parsed = safeParseUrl(origin);
  // Only http(s) URLs carry a comparable origin; others (e.g. "localhost:3000",
  // parsed with scheme "localhost") have a "null" origin, so keep them raw.
  if (
    !parsed ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    return [origin];
  }

  // Normalize to the URL origin (scheme://host:port) so a trailing slash or
  // path on FRONTEND_URL can't make one loopback alias match the browser's
  // Origin header while the other does not.
  const normalizedOrigin = parsed.origin;
  const hostname = alternateLoopbackHostname(parsed.hostname);
  if (!hostname) {
    return [normalizedOrigin];
  }

  parsed.hostname = hostname;
  const alternateOrigin = parsed.origin;
  if (alternateOrigin === normalizedOrigin) {
    return [normalizedOrigin];
  }
  return [normalizedOrigin, alternateOrigin];
};

const alternateLoopbackHostname = (hostname: string) => {
  if (hostname === "localhost") {
    return "127.0.0.1";
  }
  if (hostname === "127.0.0.1") {
    return "localhost";
  }
  return undefined;
};

const safeParseUrl = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

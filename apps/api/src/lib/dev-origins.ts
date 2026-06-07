export const DEV_INSPECTOR_ORIGINS = [
  "http://localhost:6274",
  "http://127.0.0.1:6274",
] as const;

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

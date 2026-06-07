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
  if (!parsed) {
    return [origin];
  }

  const hostname = alternateLoopbackHostname(parsed.hostname);
  if (!hostname) {
    return [origin];
  }

  parsed.hostname = hostname;
  const alternateOrigin = parsed.origin;
  if (alternateOrigin === origin) {
    return [origin];
  }
  return [origin, alternateOrigin];
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

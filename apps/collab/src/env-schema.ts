import * as v from "valibot";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const COLLAB_MODES = ["redis", "single-process"] as const;

export const isSecureStellaApiUrl = (value: string) => {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()))
  );
};

export const isSecureCollabRedisUrl = (value: string) => {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);
  return (
    url.protocol === "rediss:" ||
    (url.protocol === "redis:" &&
      LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()))
  );
};

type CollabEnvInvariantInput = {
  mode: (typeof COLLAB_MODES)[number];
  nodeEnv: string | undefined;
  redisUrl: string | undefined;
};

export const collabEnvInvariantViolation = ({
  mode,
  nodeEnv,
  redisUrl,
}: CollabEnvInvariantInput): string | null => {
  if (nodeEnv === "production" && mode === "single-process") {
    return "STELLA_COLLAB_MODE=single-process is not allowed in production.";
  }
  if (mode === "redis" && redisUrl === undefined) {
    return "STELLA_COLLAB_REDIS_URL is required in redis mode.";
  }
  if (redisUrl !== undefined && !isSecureCollabRedisUrl(redisUrl)) {
    return "STELLA_COLLAB_REDIS_URL must use rediss:// unless it targets a loopback address.";
  }
  return null;
};

export const envCollabServerSchema = {
  STELLA_API_URL: v.pipe(
    v.string(),
    v.url(),
    v.check(
      isSecureStellaApiUrl,
      "STELLA_API_URL must use HTTPS unless it targets a loopback address.",
    ),
  ),
  STELLA_COLLAB_MODE: v.optional(v.picklist(COLLAB_MODES), "single-process"),
  STELLA_COLLAB_PORT: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(65_535),
    ),
    "3002",
  ),
  STELLA_COLLAB_REDIS_URL: v.optional(v.pipe(v.string(), v.url())),
  STELLA_COLLAB_SERVICE_TOKEN: v.pipe(v.string(), v.minLength(32)),
};

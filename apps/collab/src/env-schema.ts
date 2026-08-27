import * as v from "valibot";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

export const envCollabServerSchema = {
  STELLA_API_URL: v.pipe(
    v.string(),
    v.url(),
    v.check(
      isSecureStellaApiUrl,
      "STELLA_API_URL must use HTTPS unless it targets a loopback address.",
    ),
  ),
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
};

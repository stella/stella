const DEFAULT_HOSTED_STELLA_ORIGINS = [
  "https://app.stll.app",
  "https://my.stll.app",
  "https://staging.stll.app",
] as const;

/**
 * Parses the build-time `WXT_STELLA_ORIGINS` list (comma-separated exact
 * HTTPS origins). Self-hosters set it to their own app origin; unset means the
 * hosted stella origins. A malformed entry fails the build rather than
 * silently widening or narrowing the bridge.
 */
export const parseTrustedOriginList = (
  raw: string | undefined,
): readonly string[] => {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_HOSTED_STELLA_ORIGINS;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const url = new URL(entry);
      if (url.protocol !== "https:" || url.origin !== entry) {
        throw new TypeError(
          `WXT_STELLA_ORIGINS entries must be exact HTTPS origins: ${entry}`,
        );
      }
      return url.origin;
    });
};

const HOSTED_STELLA_ORIGINS = new Set(
  parseTrustedOriginList(import.meta.env.WXT_STELLA_ORIGINS),
);

export const STELLA_CONTENT_SCRIPT_MATCHES = [
  ...[...HOSTED_STELLA_ORIGINS].map((origin) => `${origin}/*`),
  "http://localhost/*",
  "http://127.0.0.1/*",
];

export const trustedStellaOriginFromUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (HOSTED_STELLA_ORIGINS.has(url.origin)) {
      return url.origin;
    }
    if (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      return url.origin;
    }
    return null;
  } catch {
    return null;
  }
};

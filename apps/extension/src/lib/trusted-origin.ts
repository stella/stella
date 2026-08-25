export const STELLA_CONTENT_SCRIPT_MATCHES = [
  "https://app.stll.app/*",
  "https://my.stll.app/*",
  "https://staging.stll.app/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
] as const;

const HOSTED_STELLA_ORIGINS = new Set([
  "https://app.stll.app",
  "https://my.stll.app",
  "https://staging.stll.app",
]);

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

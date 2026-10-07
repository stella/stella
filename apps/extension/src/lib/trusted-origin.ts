import { panic } from "better-result";

import { buildMode, rawStellaOrigins } from "./env";

/** Hosted production stella; every build but `staging` trusts it by default. */
export const PRODUCTION_STELLA_ORIGINS = [
  "https://app.stll.app",
  "https://my.stll.app",
] as const;

/** Hosted staging stella; only the `staging` build trusts it by default. */
export const STAGING_STELLA_ORIGINS = ["https://staging.stll.app"] as const;

const HOSTED_STELLA_ORIGINS = [
  ...PRODUCTION_STELLA_ORIGINS,
  ...STAGING_STELLA_ORIGINS,
];

const STAGING_BUILD_MODE = "staging";

/** Local stella dev servers; only development and e2e builds trust them. */
const LOOPBACK_STELLA_MATCHES = [
  "http://localhost/*",
  "http://127.0.0.1/*",
] as const;

const LOOPBACK_TRUSTING_BUILD_MODES = new Set(["development", "e2e"]);

export const buildTrustsLoopback = (mode: string | undefined): boolean =>
  mode !== undefined && LOOPBACK_TRUSTING_BUILD_MODES.has(mode);

/**
 * Parses the build-time `WXT_STELLA_ORIGINS` list (comma-separated exact
 * HTTPS origins). Self-hosters set it to their own app origin; unset means the
 * hosted origins of the build mode: staging for the `staging` build,
 * production for every other one. A malformed entry fails the build rather
 * than silently widening or narrowing the bridge.
 */
export const parseTrustedOriginList = (
  raw: string | undefined,
  mode: string | undefined,
): readonly string[] => {
  if (raw === undefined || raw.trim() === "") {
    return mode === STAGING_BUILD_MODE
      ? STAGING_STELLA_ORIGINS
      : PRODUCTION_STELLA_ORIGINS;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const url = new URL(entry);
      if (url.protocol !== "https:" || url.origin !== entry) {
        return panic(
          `WXT_STELLA_ORIGINS entries must be exact HTTPS origins: ${entry}`,
        );
      }
      return url.origin;
    });
};

type StellaOriginTrustOptions = {
  hostedOrigins: readonly string[];
  trustLoopback: boolean;
};

export const createStellaOriginTrust = ({
  hostedOrigins,
  trustLoopback,
}: StellaOriginTrustOptions) => {
  const hosted = new Set(hostedOrigins);
  return {
    contentScriptMatches: [
      ...[...hosted].map((origin) => `${origin}/*`),
      ...(trustLoopback ? LOOPBACK_STELLA_MATCHES : []),
    ],
    // Every hosted stella, trusted or not, stays out of the controlled tab.
    hostnames: [
      ...new Set(
        [...hosted, ...HOSTED_STELLA_ORIGINS].map(
          (origin) => new URL(origin).hostname,
        ),
      ),
    ],
    originFromUrl: (rawUrl: string): string | null => {
      try {
        const url = new URL(rawUrl);
        if (hosted.has(url.origin)) {
          return url.origin;
        }
        if (
          trustLoopback &&
          url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ) {
          return url.origin;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
};

const stellaOriginTrust = createStellaOriginTrust({
  hostedOrigins: parseTrustedOriginList(rawStellaOrigins, buildMode),
  trustLoopback: buildTrustsLoopback(buildMode),
});

export const STELLA_CONTENT_SCRIPT_MATCHES =
  stellaOriginTrust.contentScriptMatches;

/** Hosts of the configured and hosted stella origins; never loaded under control. */
export const STELLA_HOSTNAMES = stellaOriginTrust.hostnames;

export const trustedStellaOriginFromUrl = stellaOriginTrust.originFromUrl;

import * as v from "valibot";

const featureFlagSchema = v.optional(
  v.pipe(v.string(), v.parseBoolean()),
  "false",
);

const linkUrlSchema = v.union([
  v.pipe(v.string(), v.url()),
  v.pipe(v.string(), v.regex(/^\/(?!\/)/u)),
]);

const desktopReleaseBaseUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.regex(/^https?:\/\//iu, "Desktop release base URL must use HTTP or HTTPS"),
);

export const envWebClientSchema = {
  VITE_POSTHOG_KEY: v.optional(v.string()),
  VITE_POSTHOG_HOST: v.optional(v.string()),
  VITE_POSTHOG_UI_HOST: v.optional(v.pipe(v.string(), v.url())),
  VITE_POSTHOG_LOCAL_DEBUG: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  VITE_API_URL: v.pipe(v.string(), v.url()),
  VITE_BROWSER_API_URL: v.optional(v.pipe(v.string(), v.url())),
  VITE_PUBLIC_APP_URL: v.optional(
    v.pipe(v.string(), v.url()),
    "http://localhost:3000",
  ),
  VITE_COLLAB_URL: v.optional(v.pipe(v.string(), v.url())),
  VITE_DESKTOP_BRIDGE_PORT: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(65_535),
    ),
    "45901",
  ),
  VITE_AUTH_GOOGLE: v.optional(v.pipe(v.string(), v.parseBoolean()), "false"),
  VITE_AUTH_MICROSOFT: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  // Set to "true" only on self-hosted instances. Enables the
  // in-app "update available" banner that polls the public GitHub
  // Releases API and surfaces newer versions to the operator.
  // Off by default so the hosted SaaS, where customers don't
  // upgrade themselves, never shows it.
  VITE_SELFHOST: v.optional(v.pipe(v.string(), v.parseBoolean()), "false"),
  VITE_FEATURE_CHAT: featureFlagSchema,
  VITE_FEATURE_USAGE: featureFlagSchema,
  VITE_FEATURE_KNOWLEDGE_TEMPLATES: featureFlagSchema,
  VITE_FEATURE_CASE_LAW: featureFlagSchema,
  VITE_PUBLIC_LAW_ENABLED: featureFlagSchema,
  VITE_PUBLIC_LAW_INDEXING_ENABLED: featureFlagSchema,
  VITE_PUBLIC_TOOLS_ENABLED: featureFlagSchema,
  VITE_PUBLIC_TOOLS_INDEXING_ENABLED: featureFlagSchema,
  // Whether search engines are allowed to index this deployment.
  // Off by default so deployments that should not be crawled can still
  // serve sitemaps for verification while staying non-indexable.
  VITE_SEO_INDEXABLE: featureFlagSchema,
  VITE_WORKFLOWS_ENABLED: featureFlagSchema,
  VITE_GUIDES_ENABLED: featureFlagSchema,
  VITE_FEATURE_CONTACTS: featureFlagSchema,
  VITE_FEATURE_CALENDAR: featureFlagSchema,
  VITE_FEATURE_TODOS: featureFlagSchema,
  VITE_FEATURE_MCP: featureFlagSchema,
  VITE_FEATURE_DESKTOP_EDITING: featureFlagSchema,
  VITE_FEATURE_TIME_BILLING: featureFlagSchema,
  VITE_FEATURE_FOLIO_COLLAB: featureFlagSchema,
  VITE_FEATURE_LEGAL_LISTS: featureFlagSchema,
  VITE_FEATURE_GOVERNED_WORKFLOW: featureFlagSchema,
  VITE_FEATURE_INBOX: featureFlagSchema,
  /** Lets a production deployment expose per-browser beta previews. */
  VITE_BETA_FEATURES_ENABLED: featureFlagSchema,
  VITE_FEEDBACK_EMAIL_TO: v.optional(v.pipe(v.string(), v.email())),
  VITE_TERMS_URL: v.optional(linkUrlSchema, "/terms"),
  // Base URL the desktop-app download buttons point at. Defaults
  // to upstream GitHub releases; self-hosters who mirror the
  // binaries can point this at their own host (filenames are
  // kept identical).
  VITE_DESKTOP_RELEASES_BASE_URL: v.optional(
    desktopReleaseBaseUrlSchema,
    "https://github.com/stella/stella/releases/latest/download",
  ),
};

type EnvWebInvariantInput = {
  VITE_PUBLIC_LAW_ENABLED: boolean;
  VITE_PUBLIC_LAW_INDEXING_ENABLED: boolean;
  VITE_PUBLIC_TOOLS_ENABLED: boolean;
  VITE_PUBLIC_TOOLS_INDEXING_ENABLED: boolean;
};

export const envWebInvariantViolation = ({
  VITE_PUBLIC_LAW_ENABLED,
  VITE_PUBLIC_LAW_INDEXING_ENABLED,
  VITE_PUBLIC_TOOLS_ENABLED,
  VITE_PUBLIC_TOOLS_INDEXING_ENABLED,
}: EnvWebInvariantInput): string | null => {
  if (VITE_PUBLIC_LAW_INDEXING_ENABLED && !VITE_PUBLIC_LAW_ENABLED) {
    return "VITE_PUBLIC_LAW_INDEXING_ENABLED requires VITE_PUBLIC_LAW_ENABLED.";
  }
  if (VITE_PUBLIC_TOOLS_INDEXING_ENABLED && !VITE_PUBLIC_TOOLS_ENABLED) {
    return "VITE_PUBLIC_TOOLS_INDEXING_ENABLED requires VITE_PUBLIC_TOOLS_ENABLED.";
  }
  return null;
};

export const browserApiInvariantViolation = ({
  browserApiUrl,
  publicAppUrl,
}: {
  browserApiUrl: string | undefined;
  publicAppUrl: string;
}): string | null => {
  if (browserApiUrl === undefined) {
    return null;
  }
  const browser = new URL(browserApiUrl);
  const app = new URL(publicAppUrl);
  if (browser.origin !== app.origin) {
    return "VITE_BROWSER_API_URL must share the VITE_PUBLIC_APP_URL origin.";
  }
  if (browser.pathname !== "/api" || browser.search || browser.hash) {
    return "VITE_BROWSER_API_URL must be the exact /api path without query or hash.";
  }
  return null;
};

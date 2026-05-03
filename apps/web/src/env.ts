import { createEnv } from "@t3-oss/env-core";
import * as v from "valibot";

const featureFlagSchema = v.optional(
  v.pipe(v.string(), v.parseBoolean()),
  "false",
);

const linkUrlSchema = v.union([
  v.pipe(v.string(), v.url()),
  v.pipe(v.string(), v.regex(/^\/(?!\/)/u)),
]);

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_POSTHOG_KEY: v.optional(v.string()),
    VITE_POSTHOG_HOST: v.optional(v.string()),
    VITE_POSTHOG_LOCAL_DEBUG: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    VITE_API_URL: v.pipe(v.string(), v.url()),
    VITE_DESKTOP_BRIDGE_PORT: v.optional(
      v.pipe(
        v.string(),
        v.digits(),
        v.transform(Number),
        v.integer(),
        v.minValue(1),
        v.maxValue(65_535),
      ),
      "45901",
    ),
    VITE_AI_SDK_DEVTOOLS_PORT: v.optional(
      v.pipe(
        v.string(),
        v.digits(),
        v.transform(Number),
        v.integer(),
        v.minValue(1),
        v.maxValue(65_535),
      ),
      "4983",
    ),
    VITE_AI_DEVTOOLS_ENABLED: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
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
    VITE_FEATURE_BILLING: featureFlagSchema,
    VITE_FEATURE_KNOWLEDGE_TEMPLATES: featureFlagSchema,
    VITE_FEATURE_CASE_LAW: featureFlagSchema,
    VITE_FEATURE_CONTACTS: featureFlagSchema,
    VITE_FEATURE_CALENDAR: featureFlagSchema,
    VITE_FEATURE_TODOS: featureFlagSchema,
    VITE_FEATURE_MCP: featureFlagSchema,
    VITE_FEATURE_DESKTOP_EDITING: featureFlagSchema,
    VITE_FEEDBACK_EMAIL_TO: v.optional(v.pipe(v.string(), v.email())),
    VITE_TERMS_URL: v.optional(linkUrlSchema, "/terms"),
    // Base URL the desktop-app download buttons point at. Defaults
    // to upstream GitHub releases; self-hosters who mirror the
    // binaries can point this at their own host (filenames are
    // kept identical).
    VITE_DESKTOP_RELEASES_BASE_URL: v.optional(
      v.pipe(v.string(), v.url()),
      "https://github.com/stella/stella/releases/latest/download",
    ),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});

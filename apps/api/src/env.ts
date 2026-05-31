import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";
import * as v from "valibot";

import { DEPLOYED_NODE_ENVS, envBase } from "@/api/env-base";

const featureFlagSchema = v.optional(
  v.pipe(v.string(), v.parseBoolean()),
  "false",
);

/**
 * API-specific environment variables. These are only required
 * when the full API server boots (auth, email, gotenberg, redis,
 * etc.). Scripts and CLI tools that only need DB + S3 import
 * envBase from env-base.ts instead.
 */
const envApi = createEnv({
  server: {
    AI_PROVIDER: v.optional(
      v.picklist([
        "google",
        "openrouter",
        "openai",
        "azure_foundry",
        "anthropic",
        "mistral",
        "openai_compatible",
        "huggingface",
      ]),
    ),
    AI_PROVIDER_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
    HUGGINGFACE_API_KEY: v.optional(v.string()),
    HUGGINGFACE_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
    AI_MODEL_FAST: v.optional(v.string()),
    AI_MODEL_CHAT: v.optional(v.string()),
    AI_MODEL_REASONING: v.optional(v.string()),
    AI_MODEL_PDF: v.optional(v.string()),
    AI_DEVTOOLS_ENABLED: v.optional(
      v.pipe(
        v.string(),
        v.parseBoolean(),
        v.check(
          (enabled) => !enabled || process.env.NODE_ENV === "development",
          "AI_DEVTOOLS_ENABLED is local-only and requires NODE_ENV=development.",
        ),
      ),
      "false",
    ),
    GOOGLE_GENERATIVE_AI_API_KEY: v.optional(v.string()),
    OPENROUTER_API_KEY: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    AZURE_API_KEY: v.optional(v.string()),
    AZURE_RESOURCE_NAME: v.optional(v.string()),
    AZURE_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
    AZURE_API_VERSION: v.optional(v.string()),
    ANTHROPIC_API_KEY: v.optional(v.string()),
    MISTRAL_API_KEY: v.optional(v.string()),
    GOOGLE_AI_API_KEY_EU: v.optional(v.string()),
    GOOGLE_AI_API_KEY_CH: v.optional(v.string()),
    /**
     * Force orgs to supply their own AI key (BYOK) even if the
     * instance has provisioned provider keys. Useful for shared
     * deployments without metering where the operator wants
     * costs to land on each org's own provider account.
     */
    REQUIRE_PERSONAL_AI_KEY: v.optional(
      v.pipe(v.string(), v.parseBoolean()),
      "false",
    ),
    REDIS_URL: v.pipe(v.string(), v.url()),
    USE_MOCK_AI: v.optional(v.pipe(v.string(), v.parseBoolean()), "false"),
    BETTER_AUTH_SECRET: v.pipe(v.string(), v.minLength(32)),
    BETTER_AUTH_URL: v.pipe(v.string(), v.url()),
    BETTER_AUTH_COOKIE_PREFIX: v.optional(
      v.pipe(
        v.string(),
        v.regex(
          /^[A-Za-z0-9_-]+$/u,
          "BETTER_AUTH_COOKIE_PREFIX may only contain letters, numbers, underscores, and hyphens",
        ),
      ),
    ),
    EMAIL_PROVIDER: v.pipe(
      v.picklist(["ses", "smtp"]),
      v.check((provider) => {
        if (provider === "ses") {
          return !!process.env["SES_REGION"];
        }
        return !!(process.env["SMTP_HOST"] && process.env["SMTP_PORT"]);
      }, "Missing required env vars for the selected EMAIL_PROVIDER"),
    ),
    SES_REGION: v.optional(v.string()),
    SES_ACCESS_KEY_ID: v.optional(v.string()),
    SES_SECRET_ACCESS_KEY: v.optional(v.string()),
    SES_CONFIGURATION_SET: v.optional(v.string()),
    SMTP_HOST: v.optional(v.string()),
    SMTP_PORT: v.optional(
      v.pipe(
        v.string(),
        v.digits(),
        v.transform(Number),
        v.integer(),
        v.minValue(1),
        v.maxValue(65_535),
      ),
    ),
    SMTP_USERNAME: v.optional(v.string()),
    SMTP_PASSWORD: v.optional(v.string()),
    TRANSACTIONAL_EMAIL_FROM: v.string(),
    FRONTEND_URL: v.pipe(v.string(), v.url()),
    PUBLIC_URL: v.optional(v.pipe(v.string(), v.url())),
    GOTENBERG_URL: v.pipe(v.string(), v.url()),
    GOTENBERG_USERNAME: v.string(),
    GOTENBERG_PASSWORD: v.string(),
    CONTENT_ENCRYPTION_KEY: v.optional(
      v.pipe(
        v.string(),
        v.regex(
          /^[0-9a-f]{64}$/iu,
          "CONTENT_ENCRYPTION_KEY must be a 64-character hex string",
        ),
      ),
    ),
    EXTENSION_ORIGIN: v.optional(v.pipe(v.string(), v.url())),

    /**
     * Comma-separated CIDRs of proxies the API may trust to set
     * `cf-connecting-ip`, `x-real-ip`, or `x-forwarded-for` headers.
     * Typical value covers Cloudflare's published IP ranges and any
     * load balancers in front of the API. Unset (the default) means
     * no proxy is trusted and the audit log records the socket peer
     * directly.
     */
    STELLA_TRUSTED_PROXY_CIDRS: v.optional(v.string()),

    // Social login — Google
    GOOGLE_AUTH_CLIENT_ID: v.optional(v.string()),
    GOOGLE_AUTH_CLIENT_SECRET: v.optional(v.string()),

    // Social login — Microsoft
    MICROSOFT_AUTH_CLIENT_ID: v.optional(v.string()),
    MICROSOFT_AUTH_CLIENT_SECRET: v.optional(v.string()),
    MICROSOFT_AUTH_TENANT_ID: v.optional(v.string()),

    // Launch feature flags. Keep default-off; deployment must opt in.
    FEATURE_CHAT: featureFlagSchema,
    FEATURE_BILLING: featureFlagSchema,
    FEATURE_KNOWLEDGE_TEMPLATES: featureFlagSchema,
    FEATURE_CASE_LAW: featureFlagSchema,
    FEATURE_CONTACTS: featureFlagSchema,
    FEATURE_CALENDAR: featureFlagSchema,
    FEATURE_TODOS: featureFlagSchema,
    FEATURE_MCP: featureFlagSchema,
    FEATURE_DESKTOP_EDITING: featureFlagSchema,
    FEATURE_WEB_SEARCH: featureFlagSchema,

    /**
     * Web search backend. Only Tavily is wired today; add a new
     * picklist entry alongside its WebSearchProvider implementation.
     * Leave unset to disable the tool even when FEATURE_WEB_SEARCH=true.
     */
    WEB_SEARCH_PROVIDER: v.optional(v.picklist(["tavily"])),
    TAVILY_API_KEY: v.optional(v.string()),

    /**
     * URL-fetch backend used by the chat `fetch_url` tool. Jina Reader
     * (r.jina.ai) is keyless at low volume; supply JINA_API_KEY to
     * raise the rate limit.
     */
    WEB_FETCH_PROVIDER: v.optional(v.picklist(["jina"])),
    JINA_API_KEY: v.optional(v.string()),

    /**
     * Identifying `User-Agent` header for SEC EDGAR requests. The
     * SEC mandates a real contact string (e.g. "<App name>
     * <contact@email>") on every request to data.sec.gov; without it
     * the API returns 403. Required whenever the EDGAR business
     * registry adapter is exposed; the adapter itself refuses to
     * launch with an empty value.
     */
    EDGAR_USER_AGENT: v.optional(
      v.pipe(
        v.string(),
        v.trim(),
        v.minLength(
          1,
          "EDGAR_USER_AGENT must be a non-empty identifying string (e.g. '<App name> <contact@email>') — the SEC returns 403 without one.",
        ),
      ),
    ),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

if (
  (envApi.MICROSOFT_AUTH_CLIENT_ID || envApi.MICROSOFT_AUTH_CLIENT_SECRET) &&
  !envApi.MICROSOFT_AUTH_TENANT_ID
) {
  panic(
    "MICROSOFT_AUTH_TENANT_ID is required when Microsoft OAuth is configured.",
  );
}

if (
  DEPLOYED_NODE_ENVS.has(process.env.NODE_ENV ?? "") &&
  !envApi.CONTENT_ENCRYPTION_KEY
) {
  panic(
    "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.",
  );
}

export const env = { ...envBase, ...envApi };

// Prevent accidental mutation of env vars at runtime.
// Must run AFTER createEnv has consumed process.env.
if (process.env.NODE_ENV === "production") {
  Object.freeze(process.env);
}

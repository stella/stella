import path from "node:path";
import * as v from "valibot";

import {
  NODE_ENV,
  type NodeEnvLabel,
  RUNTIME_MODE,
  type RuntimeMode,
} from "@stll/runtime-mode";

import { featureFlagSchema } from "@/api/env-base-schema";
import {
  AUTH_CLIENT_ADDRESS_HEADER,
  FRONTEND_ADDRESS_HEADER,
  FRONTEND_VERIFY_HEADER,
  ORIGIN_VERIFY_HEADER,
  SIGNUP_RATE_LIMIT_IP_SOURCE,
} from "@/api/lib/client-ip-config";
import {
  resolveInboundMailReceiving,
  type InboundMailReceivingInput,
} from "@/api/lib/email/inbound/receiving-config";
import { isTimestampAuthorityUrlList } from "@/api/lib/files/pdf-signing/timestamp-authority-urls";
import {
  DEFAULT_POLAR_API_VERSION,
  polarApiVersionSchema,
} from "@/api/lib/hosted-usage-provider/polar/contract";
import { verificationRunCapEnvSchema } from "@/api/lib/lists/verification/run-cap-config";
import { MCP_READ_MAX_ENTRIES } from "@/api/lib/rate-limit/mcp-read-fence-policy";
import { AUTH_PROVIDER_ID_PATTERN } from "@/api/lib/safe-id-boundaries";
import {
  isSecureGotenbergUrl,
  isTlsOrLoopbackUrl,
} from "@/api/lib/secure-service-url";

type EmailProviderInput = {
  EMAIL_PROVIDER?: "ses" | "smtp" | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  SMTP_PORT?: number | undefined;
  SMTP_USERNAME?: string | undefined;
};

// Keep retention cutoffs in positive ISO years supported by timestamptz.
const MAX_RETENTION_DAYS = 365_000;
// Larger timer delays are clamped to one millisecond by the runtime.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_MANAGED_PROVIDER_CHECK_TIMEOUT_MS = 30_000;

export const resolveEmailProvider = ({
  EMAIL_PROVIDER,
  SMTP_HOST,
  SMTP_PASSWORD,
  SMTP_PORT,
  SMTP_USERNAME,
}: EmailProviderInput): "ses" | "smtp" | undefined => {
  if (
    EMAIL_PROVIDER !== undefined ||
    [SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USERNAME].every(
      (value) => value === undefined,
    )
  ) {
    return EMAIL_PROVIDER;
  }
  return "smtp";
};

/**
 * API-specific environment variables. These are only required
 * when the full API server boots (auth, email, gotenberg,
 * etc.). Scripts and CLI tools that only need DB + S3 import
 * envBase from env-base.ts instead.
 */
// A header an edge sets to the viewer's address; never one the API sets,
// verifies or reads only beside the frontend verify value.
const edgeAddressHeaderName = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.regex(/^[a-z0-9-]+$/u, "must be a header name"),
  v.check(
    (name) =>
      name !== AUTH_CLIENT_ADDRESS_HEADER &&
      name !== ORIGIN_VERIFY_HEADER &&
      name !== FRONTEND_VERIFY_HEADER &&
      name !== FRONTEND_ADDRESS_HEADER,
    "must not be a header the API sets, verifies or reads from the frontend edge",
  ),
);

// Comma-separated values an edge proves itself with, each long enough not to
// be guessed.
const edgeVerifyValues = v.pipe(
  v.string(),
  v.check(
    (value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .every((part) => part.length >= 32),
    "each value must be at least 32 characters",
  ),
);

export const envApiServerSchema = {
  ...verificationRunCapEnvSchema,
  VISUAL_PREVIEW_FUNCTION_NAME: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^(?:[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]+)?|arn:aws(?:-us-gov|-cn)?:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)$/u,
      ),
    ),
  ),
  PORT: v.optional(v.pipe(v.string(), v.digits())),
  STELLA_API_PORT: v.optional(v.pipe(v.string(), v.digits())),
  AI_PROVIDER: v.optional(
    v.picklist([
      "google",
      "openrouter",
      "openai",
      "azure_foundry",
      "anthropic",
      "bedrock",
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
  GOOGLE_GENERATIVE_AI_API_KEY: v.optional(v.string()),
  /** Optional GitHub API token used only for curated catalogue traversal. */
  GITHUB_TOKEN: v.optional(v.string()),
  OPENROUTER_API_KEY: v.optional(v.string()),
  OPENROUTER_WIF_POLICY_ID: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1)),
  ),
  OPENROUTER_WIF_AUDIENCE: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1)),
  ),
  OPENROUTER_WIF_STS_REGION: v.optional(
    v.pipe(v.string(), v.trim(), v.regex(/^[a-z]+(?:-[a-z]+)+-\d+$/u)),
  ),
  /** Checks the regional model catalog before accepting managed requests. */
  FEATURE_MANAGED_PROVIDER_CHECKS: featureFlagSchema,
  MANAGED_PROVIDER_CHECK_INTERVAL_MS: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_TIMER_DELAY_MS),
    ),
  ),
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_MANAGED_PROVIDER_CHECK_TIMEOUT_MS),
    ),
  ),
  OPENAI_API_KEY: v.optional(v.string()),
  AZURE_API_KEY: v.optional(v.string()),
  AZURE_RESOURCE_NAME: v.optional(v.string()),
  AZURE_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
  AZURE_API_VERSION: v.optional(v.string()),
  ANTHROPIC_API_KEY: v.optional(v.string()),
  /**
   * Instance decision model key (TypeSafe System One). An org may set its own
   * in AI settings; with neither, typed decisions fall back to the generative
   * model.
   */
  TYPESAFE_API_KEY: v.optional(v.string()),
  /** A versioned Jev id pins calibrated thresholds; the alias moves on release. */
  TYPESAFE_MODEL: v.optional(v.string()),
  BEDROCK_API_KEY: v.optional(v.string()),
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
  /**
   * Local development and tests only. `"true"` answers AI requests with the
   * dev mock unless the organization configured its own key, which then
   * answers for real; `"force"` mocks every request, keys included, for runs
   * that must stay deterministic whatever the database holds.
   */
  USE_MOCK_AI: v.optional(
    v.union([v.literal("force"), v.pipe(v.string(), v.parseBoolean())]),
    "false",
  ),
  E2E_DISABLE_AUTH_RATE_LIMIT: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  /**
   * Local executable the Dev menu runs to reach the public-law corpus that
   * PUBLIC_LAW_DATABASE_URL and CORPUS_INDEX_Q09_SEARCH_ENDPOINT point at
   * (for example, a script that opens local tunnels). It lives outside the
   * repository so connection details never do.
   */
  DEV_PUBLIC_LAW_CONNECT_COMMAND: v.optional(
    v.pipe(v.string(), v.minLength(1)),
  ),
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
  /**
   * Enables the post-deploy synthetic-monitoring session endpoint
   * (handlers/smoke). Presence of this secret is the only gate: the
   * deployed binary is built with NODE_ENV=production and Bun inlines
   * that read, so the route cannot tell staging from production at
   * runtime. Infrastructure must inject it on non-production
   * deployments only (see handlers/smoke/routes.ts).
   */
  SMOKE_SESSION_SECRET: v.optional(v.pipe(v.string(), v.minLength(32))),
  SESSION_TOKEN_ROTATION_ENABLED: featureFlagSchema,
  SESSION_LIFETIME_CAP_ENABLED: featureFlagSchema,
  /**
   * Deployment-owned bearer credential for collaboration snapshot transport.
   * Unset disables the service-only load/store routes.
   */
  STELLA_COLLAB_SERVICE_TOKEN: v.optional(v.pipe(v.string(), v.minLength(32))),
  /** Deployment-owned operator credential. Unset disables operator HTTP access. */
  OPERATOR_API_TOKEN: v.optional(v.pipe(v.string(), v.minLength(32))),
  /**
   * SHA-256 digest of a deployment-owned decoy machine API key. The
   * plaintext decoy belongs only in a honey resource; presenting it to any
   * API route emits a structured security event and stops the request before
   * authentication. Unset disables the interceptor.
   */
  SECURITY_CANARY_API_KEY_SHA256: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^[a-f0-9]{64}$/u,
        "SECURITY_CANARY_API_KEY_SHA256 must be a lowercase SHA-256 hex digest.",
      ),
    ),
  ),
  EMAIL_PROVIDER: v.optional(v.picklist(["ses", "smtp"])),
  INBOUND_MAIL_DOMAIN: v.optional(
    v.pipe(v.string(), v.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/u)),
  ),
  INBOUND_MAIL_QUEUE_URL: v.optional(
    v.pipe(v.string(), v.url(), v.startsWith("https://")),
  ),
  INBOUND_MAIL_TOPIC_ARN: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/u),
    ),
  ),
  INBOUND_MAIL_BUCKET: v.optional(
    v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)),
  ),
  INBOUND_MAIL_KEY_PREFIX: v.optional(v.pipe(v.string(), v.maxLength(512))),
  SES_REGION: v.optional(v.string()),
  SES_ACCESS_KEY_ID: v.optional(v.string()),
  SES_SECRET_ACCESS_KEY: v.optional(v.string()),
  SES_CONFIGURATION_SET: v.optional(v.string()),
  SMTP_HOST: v.optional(v.string()),
  SMTP_PORT: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(65_535),
    ),
  ),
  SMTP_USERNAME: v.optional(v.string()),
  SMTP_PASSWORD: v.optional(v.string()),
  TRANSACTIONAL_EMAIL_FROM: v.optional(v.string()),
  /** Destination address for maintainer feedback email. */
  FEEDBACK_EMAIL_TO: v.optional(v.pipe(v.string(), v.email())),
  /**
   * GitHub issue delivery for filed feedback. Both are required together: a
   * token with no repository has nothing to post to, and a repository with no
   * token cannot be posted to. Unset, reports are stored and emailed only.
   */
  FEEDBACK_GITHUB_TOKEN: v.optional(v.pipe(v.string(), v.minLength(1))),
  FEEDBACK_GITHUB_REPO: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u,
        "FEEDBACK_GITHUB_REPO must be owner/repo",
      ),
    ),
  ),
  FRONTEND_URL: v.pipe(v.string(), v.url()),
  PUBLIC_URL: v.optional(v.pipe(v.string(), v.url())),
  GOTENBERG_URL: v.pipe(v.string(), v.url()),
  GOTENBERG_USERNAME: v.string(),
  GOTENBERG_PASSWORD: v.string(),
  EXTENSION_ORIGIN: v.optional(v.pipe(v.string(), v.url())),
  /**
   * RFC 3161 timestamp authorities for PDF signing, in preference order,
   * separated by commas or whitespace. Signing falls back to the next one
   * when an authority fails. Unset (with `PDF_SIGNING_TSA_URL` unset too)
   * signs at PAdES B-B.
   */
  PDF_SIGNING_TSA_URLS: v.optional(
    v.pipe(
      v.string(),
      v.check(
        isTimestampAuthorityUrlList,
        "PDF_SIGNING_TSA_URLS must list http(s) URLs.",
      ),
    ),
  ),
  /** Single-authority form of `PDF_SIGNING_TSA_URLS`, appended to it. */
  PDF_SIGNING_TSA_URL: v.optional(v.pipe(v.string(), v.url())),
  /**
   * Trust anchors for timestamp authorities: PEM text, or a path to a PEM
   * file. CA certificates, or an authority's own certificate to pin it.
   * Unset: timestamps are embedded but not counted as trusted time.
   */
  PDF_SIGNING_TSA_TRUST_PEM: v.optional(v.string()),

  /**
   * Self-host escape hatch for deployments without SMTP/OAuth. When enabled,
   * Better Auth's email/password endpoints are available, but sign-up is
   * limited to first-user bootstrap guarded by SELFHOST_BOOTSTRAP_TOKEN.
   * Hosted deployments should leave this off.
   */
  SELFHOST_LOCAL_PASSWORD_AUTH: featureFlagSchema,
  SELFHOST_BOOTSTRAP_TOKEN: v.optional(v.pipe(v.string(), v.minLength(32))),

  /**
   * Fixed sign-in OTP for one designated demo account, for external
   * evaluations that need working credentials without inbox access. Inert
   * unless both are set. The override applies only to the `sign-in` OTP
   * type for the exact configured address; the code still goes through the
   * normal OTP store, so the attempt limit and expiry keep applying, and
   * email delivery is skipped for this account (the code is shared
   * out-of-band).
   */
  DEMO_ACCOUNT_EMAIL: v.optional(
    v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()),
  ),
  DEMO_ACCOUNT_OTP: v.optional(v.pipe(v.string(), v.digits(), v.length(6))),
  DEMO_ACCOUNT_ORGANIZATION_ID: v.optional(
    v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
  ),

  /**
   * One restricted review account that signs in with a password and stays
   * inside its own organization. Set both or neither. Every other address is
   * refused password sign-in with the ordinary invalid-credentials answer.
   */
  APP_REVIEW_ACCOUNT_EMAIL: v.optional(
    v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email()),
  ),
  APP_REVIEW_ORGANIZATION_ID: v.optional(
    v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
  ),

  /**
   * Plain-text token served at `/.well-known/openai-apps-challenge` so an
   * external verifier can confirm control of this API's host. Unset (the
   * default), the endpoint returns 404.
   */
  OPENAI_APPS_CHALLENGE_TOKEN: v.optional(v.pipe(v.string(), v.minLength(1))),

  /**
   * Comma-separated CIDRs of proxies the API may trust to set the
   * `x-forwarded-for` header.
   * Typical value covers Cloudflare's published IP ranges and any
   * load balancers in front of the API. Unset (the default) means
   * no proxy is trusted and the audit log records the socket peer
   * directly.
   */
  STELLA_TRUSTED_PROXY_CIDRS: v.optional(v.string()),

  /**
   * Name of a header the trusted edge sets to the viewer's address with its
   * port, e.g. `cloudfront-viewer-address`. Read only from peers in
   * `STELLA_TRUSTED_PROXY_CIDRS`, ahead of the `x-forwarded-for` chain. Set it
   * only when every route to the API adds this header.
   */
  STELLA_CLIENT_ADDRESS_HEADER: v.optional(edgeAddressHeaderName),

  /**
   * How `STELLA_CLIENT_ADDRESS_HEADER` spells the address: `with-port` (as
   * `cloudfront-viewer-address` does) or `bare`.
   */
  STELLA_CLIENT_ADDRESS_FORMAT: v.optional(
    v.picklist(["with-port", "bare"]),
    "with-port",
  ),

  /**
   * Comma-separated values the edge sends in `x-stella-origin-verify` (current
   * first, then the next one during a rotation). When set, the client address
   * header is read only from requests carrying one of them.
   */
  STELLA_ORIGIN_VERIFY_SECRET: v.optional(edgeVerifyValues),

  /**
   * Comma-separated values the frontend edge sends in
   * `x-stella-frontend-verify` (current first, then the next one during a
   * rotation). From peers in `STELLA_TRUSTED_PROXY_CIDRS` carrying one of
   * them, the browser's bare address in `x-stella-viewer-address` is read
   * ahead of every other source; unset, that header is never read.
   */
  STELLA_FRONTEND_VERIFY_SECRET: v.optional(edgeVerifyValues),

  /**
   * Comma-separated user IDs allowed to publish an in-app announcement to
   * every member of their active organization. Announcements are an operator
   * capability, not a role: the deployment operator names the accounts here,
   * so no organization role can grant it. Unset (the default) means nobody
   * may announce and the endpoint answers with a configuration error rather
   * than silently accepting and dropping the request.
   */
  STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS: v.optional(v.string()),
  /**
   * Selects the trustworthy source for the signup IP rate-limit bucket.
   * Direct deployments use Bun's socket peer; deployments behind a proxy
   * require a trusted `x-forwarded-for` chain. The conservative default
   * disables the bucket unless a trusted proxy supplies that chain.
   */
  STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE: v.optional(
    v.picklist(Object.values(SIGNUP_RATE_LIMIT_IP_SOURCE)),
    SIGNUP_RATE_LIMIT_IP_SOURCE.trustedProxy,
  ),

  // Social login — Google
  GOOGLE_AUTH_CLIENT_ID: v.optional(v.string()),
  GOOGLE_AUTH_CLIENT_SECRET: v.optional(v.string()),

  // Social login — Microsoft
  MICROSOFT_AUTH_CLIENT_ID: v.optional(v.string()),
  MICROSOFT_AUTH_CLIENT_SECRET: v.optional(v.string()),
  MICROSOFT_AUTH_TENANT_ID: v.optional(v.string()),
  MICROSOFT_REQUIRE_VERIFIED_EMAIL_CLAIM: featureFlagSchema,

  // Launch feature flags. Keep default-off; deployment must opt in.
  CHAT_RUN_LOG_SHADOW: v.optional(v.pipe(v.string(), v.parseBoolean())),
  FEATURE_USAGE: featureFlagSchema,
  FEATURE_PUBLIC_LAW: featureFlagSchema,
  FEATURE_ACTION_ADMISSION: featureFlagSchema,
  FEATURE_MCP_READ_FENCE: featureFlagSchema,
  MCP_READ_WINDOW_MS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  MCP_READ_TENANT_ORG_BYTES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  MCP_READ_TENANT_USER_BYTES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  MCP_READ_PUBLIC_ORG_BYTES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  MCP_READ_PUBLIC_USER_BYTES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  MCP_READ_WINDOW_MAX_ENTRIES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MCP_READ_MAX_ENTRIES),
    ),
  ),
  ACTION_LIMIT_CONTACT_URL: v.optional(
    v.pipe(v.string(), v.url(), v.regex(/^https?:\/\//u)),
  ),
  FEATURE_ACTION_COST_RECORDS: featureFlagSchema,
  ACTION_COST_ESTIMATES: v.optional(v.string()),
  ACTION_COST_CALL_RATES: v.optional(v.string()),
  UNUSED_CLIENT_RETENTION_DAYS: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(365),
    ),
    "30",
  ),
  AGENT_REGISTRATION_DAILY_LIMIT: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(1_000_000),
    ),
    "10000",
  ),
  OPEN_CLIENT_REGISTRATION_DAILY_LIMIT: v.optional(
    v.pipe(
      v.string(),
      v.digits(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(1_000_000),
    ),
    "10000",
  ),
  ACTION_COST_RETENTION_DAYS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_RETENTION_DAYS),
    ),
  ),
  HOSTED_USAGE_WEBHOOK_RETENTION_DAYS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_RETENTION_DAYS),
    ),
  ),
  ACTION_REQUEST_MAX_BYTES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  ACTION_RESPONSE_MAX_BYTES: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  ACTION_PAGE_SIZE_MAX: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  FEATURE_ORG_SERVICE_BUDGETS: featureFlagSchema,
  FEATURE_CONFIGURED_ACCESS: featureFlagSchema,
  PAYMENT_RETRY_WINDOW_MS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  SERVICE_ACTIONS_EVALUATION_PERIOD_ACTIONS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  SERVICE_ACTIONS_SELF_MANAGED_ACTIONS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  ACTION_ADMISSION_ORG_CONCURRENCY: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)),
  ),
  ACTION_ADMISSION_USER_CONCURRENCY: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)),
  ),
  ACTION_ADMISSION_BACKGROUND_ORG_CONCURRENCY: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)),
  ),
  ACTION_ADMISSION_BACKGROUND_USER_CONCURRENCY: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)),
  ),
  // Operators must set the lease above the admission store's failover window.
  // Renewal errors retry inside that window; losing admission is not a user stop.
  ACTION_ADMISSION_LEASE_MS: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)),
  ),
  // Optional operator-owned action windows; no built-in allowance.
  ACTION_ADMISSION_PERIOD_MS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  ACTION_ADMISSION_PERIOD_ACTIONS: v.optional(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  ),
  FEATURE_TIME_BILLING: featureFlagSchema,
  FEATURE_GENERATED_VIEWS: featureFlagSchema,
  /** Dark-launch tenant-scoped AI memory until product and performance review. */
  FEATURE_AI_MEMORY: featureFlagSchema,
  /** Dark-launch first-class legal lists until the end-to-end workflow is complete. */
  FEATURE_LEGAL_LISTS: featureFlagSchema,
  /** Dark-launch governed work obligations and compatibility task behavior. */
  FEATURE_GOVERNED_WORKFLOW: featureFlagSchema,
  /** Enables reviewed GitHub-sourced skills in the authenticated catalogue. */
  FEATURE_PUBLIC_TOOLS: featureFlagSchema,
  /** Offers the bundled template-pack catalogue; off hides its routes. */
  FEATURE_TEMPLATE_PACKS: featureFlagSchema,
  FEATURE_PUBLIC_KNOWLEDGE: featureFlagSchema,
  FEATURE_WEB_SEARCH: featureFlagSchema,
  // Delegated Microsoft Graph connection: per-user, read-only SharePoint /
  // OneDrive access for future workspace import. Default-off; a deployment
  // opts in only after its Microsoft app registration is granted the
  // read-only delegated scopes (see handlers/sharepoint/graph-oauth.ts).
  FEATURE_SHAREPOINT: featureFlagSchema,

  /**
   * Dark-launch gate for the auth.md `identity_assertion` (ID-JAG)
   * path: autonomous, no-human-at-Stella registration that can
   * auto-provision an account from an externally-signed assertion.
   * Default-off; even when on, `agent_trusted_issuer` ships empty so
   * no issuer is accepted until an operator explicitly trusts one.
   */
  FEATURE_AGENT_ID_JAG: featureFlagSchema,

  /**
   * Web search backend. Only Tavily is wired today; add a new
   * picklist entry alongside its WebSearchProvider implementation.
   * Leave unset to disable the tool even when FEATURE_WEB_SEARCH=true.
   * TAVILY_API_KEY is the shared platform key; an org's own BYOK key
   * (set in settings) takes precedence per request, so a BYOK-only
   * deploy sets WEB_SEARCH_PROVIDER while leaving TAVILY_API_KEY unset.
   */
  WEB_SEARCH_PROVIDER: v.optional(v.picklist(["tavily"])),
  TAVILY_API_KEY: v.optional(v.string()),

  /**
   * URL-fetch backend used by the chat `fetch_url` tool. Jina Reader
   * (r.jina.ai) is keyless at low volume; supply JINA_API_KEY (or an
   * org BYOK key in settings, which takes precedence) to raise the
   * rate limit.
   */
  WEB_FETCH_PROVIDER: v.optional(v.picklist(["jina"])),
  JINA_API_KEY: v.optional(v.string()),

  /**
   * Identifying `User-Agent` header for SEC EDGAR requests. The
   * SEC mandates a real contact string (e.g. "<App name>
   * <contact@email>") on every request to data.sec.gov; without it
   * the API returns 403. Required whenever the EDGAR business
   * registry adapter is exposed; without it the runtime marks the
   * adapter unavailable instead of surfacing a tool that will fail.
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

  /**
   * API key for UK Companies House (https://api.company-information.service.gov.uk).
   * The upstream authenticates every request via HTTP Basic with
   * this key as the username and an empty password; missing or
   * wrong credentials return 401. Free, instant via
   * https://developer.company-information.service.gov.uk. Required
   * whenever the Companies House business registry adapter is
   * exposed; without it the runtime marks the adapter unavailable
   * instead of surfacing a tool that will fail.
   */
  COMPANIES_HOUSE_API_KEY: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(
        1,
        "COMPANIES_HOUSE_API_KEY must be a non-empty API key from https://developer.company-information.service.gov.uk — the API returns 401 without one.",
      ),
    ),
  ),

  /**
   * API token for Mexico's INEGI DENUE
   * (https://www.inegi.org.mx/servicios/api_denue.html). Required
   * whenever the DENUE business-data adapter is exposed; without it
   * the runtime marks the adapter unavailable instead of surfacing a
   * registry tool that will fail.
   */
  INEGI_DENUE_API_TOKEN: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(
        1,
        "INEGI_DENUE_API_TOKEN must be a non-empty token from https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx.",
      ),
    ),
  ),

  /** Optional hosted usage integration settings. */
  HOSTED_USAGE_WEBHOOK_SECRET: v.optional(v.pipe(v.string(), v.minLength(16))),
  /**
   * Previous webhook secret kept active during a rotation
   * window. When set, both this and the current secret are
   * accepted for HMAC verification so in-flight deliveries keep
   * working while the rotation propagates.
   */
  HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS: v.optional(
    v.pipe(v.string(), v.minLength(16)),
  ),
  HOSTED_USAGE_PROVIDER_API_VERSION: v.optional(
    polarApiVersionSchema,
    DEFAULT_POLAR_API_VERSION,
  ),
  HOSTED_USAGE_PROVIDER_API_KEY: v.optional(v.pipe(v.string(), v.minLength(8))),
  HOSTED_USAGE_PROVIDER_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
  /**
   * Selects how hosted usage provider API calls and webhook events are
   * shaped. `neutral` (default) speaks the provider-agnostic contract
   * directly. `polar` translates Polar's native checkout /
   * customer-session API and `subscription.*` / `order.*` webhook events
   * to and from that contract (see lib/hosted-usage-provider/polar).
   */
  HOSTED_USAGE_PROVIDER: v.optional(
    v.picklist(["neutral", "polar"]),
    "neutral",
  ),

  /** Enables pre-flight usage-limit enforcement when true. */
  USAGE_ENFORCEMENT_ENABLED: featureFlagSchema,

  /**
   * Enforces the persisted per-organization access state: organizations
   * recorded as self-managed-keys, or whose evaluation period is over, never
   * fall back to the instance model provider.
   */
  FEATURE_ORG_ACCESS_STATE: featureFlagSchema,

  /**
   * Falls every organization whose evaluation or paid access has lapsed back
   * to the seeded `free` usage policy instead of ending its access. The free
   * budget is the policy's service actions per `ACTION_ADMISSION_PERIOD_MS`
   * (one month in production; staging may run a daily period for tests).
   */
  FEATURE_FREE_TIER: featureFlagSchema,

  /** Enforces organization file byte reservations at storage writes. */

  /** Length of an organization's evaluation period, in days. */
  ORG_EVALUATION_PERIOD_DAYS: v.optional(
    v.pipe(v.string(), v.digits(), v.toNumber(), v.integer(), v.minValue(1)),
  ),

  AGENT_CLIENT_STORAGE_V1_ENABLED: featureFlagSchema,

  /** Enables agent-sandbox chat runs when true. */
  AGENT_SANDBOX_RUNS_ENABLED: featureFlagSchema,

  /**
   * Directory holding the template-pack content (`packs/<id>/…`). The image
   * copies the checked-out submodule there; a source tree leaves this unset
   * and the package falls back to its own `content/` mount.
   */
  TEMPLATE_PACKS_CONTENT_DIR: v.optional(v.string()),

  /**
   * Agent-sandbox engine config. The schema keeps these optional
   * so deployments with the feature disabled need no sandbox infrastructure.
   * An explicit agent request fails closed unless every required field is
   * present. The harness key is supplied through deployment configuration.
   */
  AGENT_SANDBOX_IMAGE: v.optional(v.string()),
  AGENT_SANDBOX_HARNESS_MODEL: v.optional(v.string()),
  AGENT_SANDBOX_HARNESS_API_KEY: v.optional(v.string()),
  AGENT_SANDBOX_HARNESS_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
  /** Container-reachable MCP base URL, e.g. http://host.docker.internal:3001/mcp */
  AGENT_SANDBOX_MCP_URL: v.optional(v.pipe(v.string(), v.url())),
  /** Docker daemon socket; Linux default is /var/run/docker.sock. */
  AGENT_SANDBOX_DOCKER_SOCKET: v.optional(v.string()),
  /**
   * Docker network for the sandbox container (`HostConfig.NetworkMode`).
   * Required when agent runs are enabled. It must name a locked-down network
   * that denies arbitrary egress so injected secrets cannot be exfiltrated.
   */
  AGENT_SANDBOX_DOCKER_NETWORK: v.optional(v.string()),

  /**
   * Break-glass diagnostics. When true, 5xx responses additionally
   * log the full `error.msg` and `error.stack` so a deployment can be
   * made fully diagnosable by flipping one env var, no rebuild needed.
   * Default false preserves the redacted-by-default behaviour: only
   * the non-PII structural fingerprint (class, code, code-location
   * frames) is logged. Enable transiently for an investigation, never
   * as a standing default, since stacks/messages may carry client
   * data.
   */
  DEBUG_UNREDACTED_ERRORS: featureFlagSchema,

  /**
   * Deployment-owned usage-policy seed list. JSON array of
   * { key, displayName, monthlyUsageUnits, hostedPolicyRef? }.
   * Default is intentionally empty so public source does not
   * encode an operator policy.
   */
  STELLA_USAGE_POLICY_SEEDS: v.optional(v.string(), "[]"),

  /**
   * Absolute path of a directory holding additional report specs, one
   * `<key>/spec.json` (plus `prompts/*.md`) per subdirectory. A key found
   * here overrides the bundled spec of the same name. Must exist at boot.
   */
  REPORT_SPECS_DIR: v.optional(
    v.pipe(
      v.string(),
      v.check(path.isAbsolute, "REPORT_SPECS_DIR must be an absolute path."),
    ),
  ),

  /**
   * `s3://bucket/prefix/` holding additional report specs in the same
   * `<key>/spec.json` + `<key>/prompts/*.md` layout as REPORT_SPECS_DIR, read
   * once at boot. Exclusive with REPORT_SPECS_DIR.
   */
  REPORT_SPECS_S3_PREFIX: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^s3:\/\/[^/\s]+\/(?:[^/\s]+\/)*$/u,
        "REPORT_SPECS_S3_PREFIX must look like s3://bucket/prefix/ (trailing slash).",
      ),
    ),
  ),
};

type EnvApiInvariantInput = InboundMailReceivingInput & {
  APP_REVIEW_ACCOUNT_EMAIL?: string | undefined;
  APP_REVIEW_ORGANIZATION_ID?: string | undefined;
  AI_PROVIDER?: v.InferOutput<typeof envApiServerSchema.AI_PROVIDER>;
  FEATURE_MANAGED_PROVIDER_CHECKS?: boolean | undefined;
  MANAGED_PROVIDER_CHECK_INTERVAL_MS?: number | undefined;
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS?: number | undefined;
  OPENROUTER_API_KEY?: string | undefined;
  OPENROUTER_WIF_POLICY_ID?: string | undefined;
  OPENROUTER_WIF_AUDIENCE?: string | undefined;
  OPENROUTER_WIF_STS_REGION?: string | undefined;
  BETTER_AUTH_URL: string;
  DEV_PUBLIC_LAW_CONNECT_COMMAND?: string | undefined;
  E2E_DISABLE_AUTH_RATE_LIMIT: boolean;
  EMAIL_PROVIDER?: "ses" | "smtp" | undefined;
  FEATURE_ACTION_ADMISSION?: boolean | undefined;
  FEATURE_ORG_ACCESS_STATE?: boolean | undefined;
  FEATURE_ORG_SERVICE_BUDGETS?: boolean | undefined;
  FEATURE_CONFIGURED_ACCESS?: boolean | undefined;
  FEATURE_FREE_TIER?: boolean | undefined;
  FEATURE_USAGE?: boolean | undefined;
  USAGE_ENFORCEMENT_ENABLED?: boolean | undefined;
  PAYMENT_RETRY_WINDOW_MS?: number | undefined;
  FRONTEND_URL: string;
  GOTENBERG_URL: string;
  MICROSOFT_AUTH_CLIENT_ID?: string | undefined;
  MICROSOFT_AUTH_CLIENT_SECRET?: string | undefined;
  MICROSOFT_AUTH_TENANT_ID?: string | undefined;
  ORG_EVALUATION_PERIOD_DAYS?: number | undefined;
  PUBLIC_URL?: string | undefined;
  REPORT_SPECS_DIR?: string | undefined;
  REPORT_SPECS_S3_PREFIX?: string | undefined;
  SES_REGION?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: number | undefined;
  TRANSACTIONAL_EMAIL_FROM?: string | undefined;
  USE_MOCK_AI: boolean | "force";
  nodeEnv: NodeEnvLabel;
  runtimeMode: RuntimeMode;
};

type ManagedProviderCheckInvariantInput = Pick<
  EnvApiInvariantInput,
  | "AI_PROVIDER"
  | "FEATURE_MANAGED_PROVIDER_CHECKS"
  | "MANAGED_PROVIDER_CHECK_INTERVAL_MS"
  | "MANAGED_PROVIDER_CHECK_TIMEOUT_MS"
  | "OPENROUTER_API_KEY"
  | "OPENROUTER_WIF_POLICY_ID"
  | "OPENROUTER_WIF_AUDIENCE"
  | "OPENROUTER_WIF_STS_REGION"
>;

const managedProviderCheckInvariantViolation = ({
  AI_PROVIDER,
  FEATURE_MANAGED_PROVIDER_CHECKS,
  MANAGED_PROVIDER_CHECK_INTERVAL_MS,
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS,
  OPENROUTER_API_KEY,
  OPENROUTER_WIF_POLICY_ID,
  OPENROUTER_WIF_AUDIENCE,
  OPENROUTER_WIF_STS_REGION,
}: ManagedProviderCheckInvariantInput): string | null => {
  const configuredWifFields = [
    OPENROUTER_WIF_POLICY_ID,
    OPENROUTER_WIF_AUDIENCE,
    OPENROUTER_WIF_STS_REGION,
  ].filter((value) => value !== undefined).length;
  if (configuredWifFields !== 0 && configuredWifFields !== 3) {
    return "OPENROUTER_WIF_POLICY_ID, OPENROUTER_WIF_AUDIENCE, and OPENROUTER_WIF_STS_REGION must be configured together.";
  }
  if (FEATURE_MANAGED_PROVIDER_CHECKS) {
    if (AI_PROVIDER !== "openrouter") {
      return "FEATURE_MANAGED_PROVIDER_CHECKS requires AI_PROVIDER=openrouter.";
    }
    if (!OPENROUTER_API_KEY?.trim() && configuredWifFields !== 3) {
      return "FEATURE_MANAGED_PROVIDER_CHECKS requires OPENROUTER_API_KEY or complete OpenRouter WIF configuration.";
    }
    if (
      MANAGED_PROVIDER_CHECK_INTERVAL_MS === undefined ||
      MANAGED_PROVIDER_CHECK_TIMEOUT_MS === undefined ||
      MANAGED_PROVIDER_CHECK_TIMEOUT_MS >= MANAGED_PROVIDER_CHECK_INTERVAL_MS
    ) {
      return "FEATURE_MANAGED_PROVIDER_CHECKS requires positive MANAGED_PROVIDER_CHECK_INTERVAL_MS and MANAGED_PROVIDER_CHECK_TIMEOUT_MS; timeout must be shorter than interval.";
    }
  }
  return null;
};

type FreeTierInvariantInput = Pick<
  EnvApiInvariantInput,
  | "FEATURE_FREE_TIER"
  | "FEATURE_ORG_ACCESS_STATE"
  | "FEATURE_ORG_SERVICE_BUDGETS"
  | "USAGE_ENFORCEMENT_ENABLED"
>;

/**
 * The free floor resolves from the access state and draws on the service
 * budget. Usage enforcement refuses any organization without a usage
 * entitlement, which a free organization never has, so the two cannot run
 * together.
 */
export const freeTierInvariantViolation = ({
  FEATURE_FREE_TIER,
  FEATURE_ORG_ACCESS_STATE,
  FEATURE_ORG_SERVICE_BUDGETS,
  USAGE_ENFORCEMENT_ENABLED,
}: FreeTierInvariantInput): string | null => {
  if (!FEATURE_FREE_TIER) {
    return null;
  }
  if (USAGE_ENFORCEMENT_ENABLED) {
    return "FEATURE_FREE_TIER requires USAGE_ENFORCEMENT_ENABLED to be off.";
  }
  if (!FEATURE_ORG_ACCESS_STATE || !FEATURE_ORG_SERVICE_BUDGETS) {
    return "FEATURE_FREE_TIER requires FEATURE_ORG_ACCESS_STATE and FEATURE_ORG_SERVICE_BUDGETS.";
  }
  return null;
};

type ReviewAccountInvariantInput = Pick<
  EnvApiInvariantInput,
  "APP_REVIEW_ACCOUNT_EMAIL" | "APP_REVIEW_ORGANIZATION_ID"
>;

const reviewAccountInvariantViolation = ({
  APP_REVIEW_ACCOUNT_EMAIL,
  APP_REVIEW_ORGANIZATION_ID,
}: ReviewAccountInvariantInput): string | null =>
  (APP_REVIEW_ACCOUNT_EMAIL === undefined) ===
  (APP_REVIEW_ORGANIZATION_ID === undefined)
    ? null
    : "APP_REVIEW_ACCOUNT_EMAIL and APP_REVIEW_ORGANIZATION_ID must be set together.";

// Feature-owned invariants, kept out of the top-level check's branch budget.
const delegatedInvariantViolation = (
  input: ManagedProviderCheckInvariantInput &
    InboundMailReceivingInput &
    FreeTierInvariantInput &
    ReviewAccountInvariantInput &
    Pick<EnvApiInvariantInput, "runtimeMode">,
): string | null => {
  const reviewAccountViolation = reviewAccountInvariantViolation(input);
  if (reviewAccountViolation !== null) {
    return reviewAccountViolation;
  }
  const managedViolation = managedProviderCheckInvariantViolation(input);
  if (managedViolation !== null) {
    return managedViolation;
  }
  const freeTierViolation = freeTierInvariantViolation(input);
  if (freeTierViolation !== null) {
    return freeTierViolation;
  }
  const inboundMail = resolveInboundMailReceiving(input);
  return inboundMail.isErr() ? inboundMail.error.message : null;
};

export const envApiInvariantViolation = ({
  APP_REVIEW_ACCOUNT_EMAIL,
  APP_REVIEW_ORGANIZATION_ID,
  AI_PROVIDER,
  FEATURE_MANAGED_PROVIDER_CHECKS,
  MANAGED_PROVIDER_CHECK_INTERVAL_MS,
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS,
  OPENROUTER_API_KEY,
  OPENROUTER_WIF_POLICY_ID,
  OPENROUTER_WIF_AUDIENCE,
  OPENROUTER_WIF_STS_REGION,
  BETTER_AUTH_URL,
  DEV_PUBLIC_LAW_CONNECT_COMMAND,
  E2E_DISABLE_AUTH_RATE_LIMIT,
  EMAIL_PROVIDER,
  FEATURE_ACTION_ADMISSION,
  FEATURE_ORG_ACCESS_STATE,
  FEATURE_ORG_SERVICE_BUDGETS,
  FEATURE_CONFIGURED_ACCESS,
  FEATURE_FREE_TIER,
  FEATURE_USAGE,
  USAGE_ENFORCEMENT_ENABLED,
  PAYMENT_RETRY_WINDOW_MS,
  FRONTEND_URL,
  GOTENBERG_URL,
  MICROSOFT_AUTH_CLIENT_ID,
  MICROSOFT_AUTH_CLIENT_SECRET,
  MICROSOFT_AUTH_TENANT_ID,
  ORG_EVALUATION_PERIOD_DAYS,
  PUBLIC_URL,
  REPORT_SPECS_DIR,
  REPORT_SPECS_S3_PREFIX,
  SES_REGION,
  SMTP_HOST,
  SMTP_PORT,
  TRANSACTIONAL_EMAIL_FROM,
  USE_MOCK_AI,
  nodeEnv,
  runtimeMode,
  INBOUND_MAIL_DOMAIN,
  INBOUND_MAIL_QUEUE_URL,
  INBOUND_MAIL_TOPIC_ARN,
  INBOUND_MAIL_BUCKET,
  INBOUND_MAIL_KEY_PREFIX,
}: EnvApiInvariantInput): string | null => {
  if (
    FEATURE_CONFIGURED_ACCESS &&
    ![
      FEATURE_ORG_ACCESS_STATE,
      FEATURE_ORG_SERVICE_BUDGETS,
      FEATURE_USAGE,
      PAYMENT_RETRY_WINDOW_MS !== undefined,
    ].every(Boolean)
  ) {
    return "FEATURE_CONFIGURED_ACCESS requires FEATURE_ORG_ACCESS_STATE, FEATURE_ORG_SERVICE_BUDGETS, FEATURE_USAGE and PAYMENT_RETRY_WINDOW_MS.";
  }
  const delegatedViolation = delegatedInvariantViolation({
    APP_REVIEW_ACCOUNT_EMAIL,
    APP_REVIEW_ORGANIZATION_ID,
    AI_PROVIDER,
    FEATURE_MANAGED_PROVIDER_CHECKS,
    MANAGED_PROVIDER_CHECK_INTERVAL_MS,
    MANAGED_PROVIDER_CHECK_TIMEOUT_MS,
    OPENROUTER_API_KEY,
    OPENROUTER_WIF_POLICY_ID,
    OPENROUTER_WIF_AUDIENCE,
    OPENROUTER_WIF_STS_REGION,
    INBOUND_MAIL_DOMAIN,
    INBOUND_MAIL_QUEUE_URL,
    INBOUND_MAIL_TOPIC_ARN,
    INBOUND_MAIL_BUCKET,
    INBOUND_MAIL_KEY_PREFIX,
    FEATURE_FREE_TIER,
    FEATURE_ORG_ACCESS_STATE,
    FEATURE_ORG_SERVICE_BUDGETS,
    USAGE_ENFORCEMENT_ENABLED,
    runtimeMode,
  });
  if (delegatedViolation !== null) {
    return delegatedViolation;
  }
  const localDevOpen = runtimeMode.mode === RUNTIME_MODE.open;
  if (REPORT_SPECS_DIR !== undefined && REPORT_SPECS_S3_PREFIX !== undefined) {
    return "REPORT_SPECS_DIR and REPORT_SPECS_S3_PREFIX are exclusive; set one.";
  }
  if (!localDevOpen) {
    const insecurePublicOrigin = [
      { name: "BETTER_AUTH_URL", value: BETTER_AUTH_URL },
      { name: "FRONTEND_URL", value: FRONTEND_URL },
      { name: "PUBLIC_URL", value: PUBLIC_URL },
    ].find(
      ({ value }) =>
        value !== undefined &&
        !isTlsOrLoopbackUrl(value, {
          plaintextProtocol: "http:",
          tlsProtocol: "https:",
        }),
    );
    if (insecurePublicOrigin !== undefined) {
      return `${insecurePublicOrigin.name} must use HTTPS unless it targets a loopback address.`;
    }
    // Document content and the sidecar's basic-auth credentials travel this
    // URL. Left unchecked since the self-hosting rework; the rule is back with
    // the private-network forms that rework needed.
    if (!isSecureGotenbergUrl(GOTENBERG_URL)) {
      return "GOTENBERG_URL must use HTTPS unless it targets a loopback address or a private deployment network.";
    }
  }
  if (
    E2E_DISABLE_AUTH_RATE_LIMIT &&
    !(localDevOpen && nodeEnv === NODE_ENV.development)
  ) {
    return "E2E_DISABLE_AUTH_RATE_LIMIT is test-only and requires NODE_ENV=development with STELLA_LOCAL_DEV=1.";
  }
  if (DEV_PUBLIC_LAW_CONNECT_COMMAND !== undefined && !localDevOpen) {
    return "DEV_PUBLIC_LAW_CONNECT_COMMAND is only supported in local development and tests.";
  }
  if (USE_MOCK_AI !== false && !localDevOpen) {
    return "USE_MOCK_AI is only supported in local development and tests.";
  }
  if (FEATURE_ORG_ACCESS_STATE && ORG_EVALUATION_PERIOD_DAYS === undefined) {
    return "ORG_EVALUATION_PERIOD_DAYS is required when FEATURE_ORG_ACCESS_STATE is true.";
  }
  if (FEATURE_ORG_SERVICE_BUDGETS && !FEATURE_ACTION_ADMISSION) {
    return "FEATURE_ORG_SERVICE_BUDGETS requires FEATURE_ACTION_ADMISSION.";
  }
  if (
    (MICROSOFT_AUTH_CLIENT_ID || MICROSOFT_AUTH_CLIENT_SECRET) &&
    !MICROSOFT_AUTH_TENANT_ID
  ) {
    return "MICROSOFT_AUTH_TENANT_ID is required when Microsoft OAuth is configured.";
  }
  if (EMAIL_PROVIDER === "ses") {
    return SES_REGION && TRANSACTIONAL_EMAIL_FROM
      ? null
      : "Missing required env vars for the selected EMAIL_PROVIDER.";
  }
  if (EMAIL_PROVIDER === "smtp") {
    return SMTP_HOST && SMTP_PORT !== undefined && TRANSACTIONAL_EMAIL_FROM
      ? null
      : "Missing required env vars for the selected EMAIL_PROVIDER.";
  }
  return null;
};

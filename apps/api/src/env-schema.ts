import path from "node:path";
import * as v from "valibot";

import { DEPLOYED_NODE_ENVS, featureFlagSchema } from "@/api/env-base-schema";
import { SIGNUP_RATE_LIMIT_IP_SOURCE } from "@/api/lib/client-ip-config";
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
export const envApiServerSchema = {
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
  OPENAI_API_KEY: v.optional(v.string()),
  AZURE_API_KEY: v.optional(v.string()),
  AZURE_RESOURCE_NAME: v.optional(v.string()),
  AZURE_BASE_URL: v.optional(v.pipe(v.string(), v.url())),
  AZURE_API_VERSION: v.optional(v.string()),
  ANTHROPIC_API_KEY: v.optional(v.string()),
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
  USE_MOCK_AI: v.optional(v.pipe(v.string(), v.parseBoolean()), "false"),
  E2E_DISABLE_AUTH_RATE_LIMIT: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
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
  /**
   * Bearer token for the operator registrations endpoint
   * (handlers/operator): lets an instance operator list recent
   * account registrations over HTTP instead of opening a database
   * shell. Unset disables the endpoint entirely (requests return
   * 404), mirroring how other optional operational surfaces behave.
   */
  OPERATOR_METRICS_TOKEN: v.optional(v.pipe(v.string(), v.minLength(32))),
  /**
   * Deployment-owned bearer credential for collaboration snapshot transport.
   * Unset disables the service-only load/store routes.
   */
  STELLA_COLLAB_SERVICE_TOKEN: v.optional(v.pipe(v.string(), v.minLength(32))),
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
  /**
   * Destination address for the MCP `send_feedback` email channel. Optional:
   * when unset the tool falls back to the github channel and refuses the
   * email channel with a `feature_disabled` envelope. Requires a configured
   * EMAIL_PROVIDER to actually deliver.
   */
  FEEDBACK_EMAIL_TO: v.optional(v.pipe(v.string(), v.email())),
  /**
   * Where the MCP `send_feedback` "stella" channel forwards approved,
   * sanitized feedback: the hosted intake receiver. Defaults to Stella's
   * hosted API (`https://api.stll.app/public/feedback`); a self-hosted
   * deployment can point it at its own intake or a proxy. When the tool runs
   * on the hosted instance this points back at itself, which is a normal
   * round trip.
   */
  FEEDBACK_INTAKE_URL: v.optional(
    v.pipe(v.string(), v.url()),
    "https://api.stll.app/public/feedback",
  ),
  FRONTEND_URL: v.pipe(v.string(), v.url()),
  PUBLIC_URL: v.optional(v.pipe(v.string(), v.url())),
  GOTENBERG_URL: v.pipe(v.string(), v.url()),
  GOTENBERG_USERNAME: v.string(),
  GOTENBERG_PASSWORD: v.string(),
  EXTENSION_ORIGIN: v.optional(v.pipe(v.string(), v.url())),

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

  // Launch feature flags. Keep default-off; deployment must opt in.
  FEATURE_CHAT: featureFlagSchema,
  FEATURE_USAGE: featureFlagSchema,
  FEATURE_KNOWLEDGE_TEMPLATES: featureFlagSchema,
  FEATURE_CASE_LAW: featureFlagSchema,
  FEATURE_PUBLIC_LAW: featureFlagSchema,
  FEATURE_CONTACTS: featureFlagSchema,
  FEATURE_CALENDAR: featureFlagSchema,
  FEATURE_TODOS: featureFlagSchema,
  FEATURE_MCP: featureFlagSchema,
  FEATURE_DESKTOP_EDITING: featureFlagSchema,
  FEATURE_TIME_BILLING: featureFlagSchema,
  /** Dark-launch tenant-scoped AI memory until product and performance review. */
  FEATURE_AI_MEMORY: featureFlagSchema,
  /** Dark-launch first-class legal lists until the end-to-end workflow is complete. */
  FEATURE_LEGAL_LISTS: featureFlagSchema,
  /** Dark-launch governed work obligations and compatibility task behavior. */
  FEATURE_GOVERNED_WORKFLOW: featureFlagSchema,
  /** Opt-in model-backed inbox producers (deadline and review scouts); they spend AI usage per processed document. */
  /** Enables reviewed GitHub-sourced skills in the authenticated catalogue. */
  FEATURE_PUBLIC_TOOLS: featureFlagSchema,
  /** Offers the bundled template-pack catalogue; off hides its routes. */
  FEATURE_TEMPLATE_PACKS: featureFlagSchema,
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

type EnvApiInvariantInput = {
  BETTER_AUTH_URL: string;
  E2E_DISABLE_AUTH_RATE_LIMIT: boolean;
  EMAIL_PROVIDER?: "ses" | "smtp" | undefined;
  FRONTEND_URL: string;
  GOTENBERG_URL: string;
  MICROSOFT_AUTH_CLIENT_ID?: string | undefined;
  MICROSOFT_AUTH_CLIENT_SECRET?: string | undefined;
  MICROSOFT_AUTH_TENANT_ID?: string | undefined;
  PUBLIC_URL?: string | undefined;
  REPORT_SPECS_DIR?: string | undefined;
  REPORT_SPECS_S3_PREFIX?: string | undefined;
  SES_REGION?: string | undefined;
  SMTP_HOST?: string | undefined;
  SMTP_PORT?: number | undefined;
  TRANSACTIONAL_EMAIL_FROM?: string | undefined;
  USE_MOCK_AI: boolean;
  nodeEnv?: string | undefined;
};

export const envApiInvariantViolation = ({
  BETTER_AUTH_URL,
  E2E_DISABLE_AUTH_RATE_LIMIT,
  EMAIL_PROVIDER,
  FRONTEND_URL,
  GOTENBERG_URL,
  MICROSOFT_AUTH_CLIENT_ID,
  MICROSOFT_AUTH_CLIENT_SECRET,
  MICROSOFT_AUTH_TENANT_ID,
  PUBLIC_URL,
  REPORT_SPECS_DIR,
  REPORT_SPECS_S3_PREFIX,
  SES_REGION,
  SMTP_HOST,
  SMTP_PORT,
  TRANSACTIONAL_EMAIL_FROM,
  USE_MOCK_AI,
  nodeEnv,
}: EnvApiInvariantInput): string | null => {
  if (REPORT_SPECS_DIR !== undefined && REPORT_SPECS_S3_PREFIX !== undefined) {
    return "REPORT_SPECS_DIR and REPORT_SPECS_S3_PREFIX are exclusive; set one.";
  }
  if (DEPLOYED_NODE_ENVS.has(nodeEnv ?? "")) {
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
  if (E2E_DISABLE_AUTH_RATE_LIMIT && nodeEnv !== "development") {
    return "E2E_DISABLE_AUTH_RATE_LIMIT is test-only and requires NODE_ENV=development.";
  }
  if (USE_MOCK_AI && DEPLOYED_NODE_ENVS.has(nodeEnv ?? "")) {
    return "USE_MOCK_AI is only supported in local development and tests.";
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

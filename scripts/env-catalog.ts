import type * as v from "valibot";

import {
  databaseComponentEnvSchema,
  envBaseServerSchema,
} from "../apps/api/src/env-base-schema";
import { envDocumentProcessingWorkerServerSchema } from "../apps/api/src/env-document-processing-worker-schema";
import { envApiServerSchema } from "../apps/api/src/env-schema";
import { envCollabServerSchema } from "../apps/collab/src/env-schema";
import { envWebClientSchema } from "../apps/web/src/env-schema";

export const ENV_EXPOSURE = {
  internal: "internal",
  public: "public",
  secret: "secret",
} as const;

export type EnvExposure = (typeof ENV_EXPOSURE)[keyof typeof ENV_EXPOSURE];

export const ENV_REQUIREMENT = {
  conditional: "conditional",
  defaulted: "defaulted",
  optional: "optional",
  required: "required",
} as const;

export type EnvRequirement =
  (typeof ENV_REQUIREMENT)[keyof typeof ENV_REQUIREMENT];

export const ENV_OWNER = {
  apiBase: "api-base",
  apiServer: "api-server",
  cli: "cli",
  collab: "collab",
  documentWorker: "document-worker",
  legalAtlasRunner: "legal-atlas-runner",
  web: "web",
} as const;

export type EnvOwner = (typeof ENV_OWNER)[keyof typeof ENV_OWNER];

export type EnvCatalogEntry = {
  description: string;
  documented: boolean;
  example: string | undefined;
  exposure: EnvExposure;
  name: string;
  owner: EnvOwner;
  requirement: EnvRequirement;
  requirementNote: string | undefined;
  schema: v.GenericSchema;
  section: string;
};

type SchemaRecord = Record<string, v.GenericSchema>;

const INTERNAL_SERVER_KEYS = new Set([
  "AGENT_SANDBOX_DOCKER_NETWORK",
  "AGENT_SANDBOX_DOCKER_SOCKET",
  "AGENT_SANDBOX_HARNESS_BASE_URL",
  "AGENT_SANDBOX_HARNESS_MODEL",
  "AGENT_SANDBOX_IMAGE",
  "AGENT_SANDBOX_MCP_URL",
  "AGENT_SANDBOX_RUNS_ENABLED",
  "AI_MODEL_CHAT",
  "AI_MODEL_FAST",
  "AI_MODEL_PDF",
  "AI_MODEL_REASONING",
  "AI_PROVIDER",
  "AI_PROVIDER_BASE_URL",
  "AZURE_API_VERSION",
  "AZURE_BASE_URL",
  "AZURE_RESOURCE_NAME",
  "BETTER_AUTH_COOKIE_PREFIX",
  "BETTER_AUTH_URL",
  "CASE_LAW_DATABASE_POOL_MAX",
  "PUBLIC_LAW_DATABASE_POOL_MAX",
  "CORPUS_INDEXING_ENABLED",
  "CORPUS_PROJECTION_OWNER",
  "CORPUS_INDEX_BACKPRESSURE_DIMENSIONS",
  "CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK",
  "CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK",
  "CORPUS_INDEX_BACKPRESSURE_METRIC",
  "CORPUS_INDEX_BACKPRESSURE_NAMESPACE",
  "CORPUS_INDEX_BACKPRESSURE_SAMPLE_INTERVAL_MS",
  "CORPUS_INDEX_BATCH_SIZE",
  "CORPUS_INDEX_ENDPOINT",
  "CORPUS_INDEX_INTERVAL_MS",
  "CORPUS_INDEX_Q09_ENDPOINT",
  "CORPUS_INDEX_Q09_SEARCH_ENDPOINT",
  "CORPUS_INDEX_READ_CONCURRENCY",
  "CORPUS_INDEX_SEARCH_ENDPOINT",
  "CORPUS_INDEX_S3_BUCKET",
  "CORPUS_STORAGE_ENABLED",
  "CORPUS_STORAGE_MODE",
  "DATABASE_POOL_IDLE_TIMEOUT_S",
  "DATABASE_POOL_MAX_LIFETIME_S",
  "DATABASE_RLS_POOL_MAX",
  "DATABASE_ROOT_POOL_MAX",
  "DB_HOST",
  "DB_NAME",
  "DB_PORT",
  "DB_SSLMODE",
  "DB_USER",
  "DEBUG_UNREDACTED_ERRORS",
  "DOCUMENT_OCR_BATCH_INTERVAL_MINUTES",
  "DOCUMENT_OCR_MODEL_DIR",
  "DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES",
  "E2E_DISABLE_AUTH_RATE_LIMIT",
  "EMAIL_PROVIDER",
  "EXTENSION_ORIGIN",
  "FEATURE_AGENT_ID_JAG",
  "FEATURE_AI_MEMORY",
  "FEATURE_CALENDAR",
  "FEATURE_CASE_LAW",
  "FEATURE_CHAT",
  "FEATURE_CONTACTS",
  "FEATURE_DESKTOP_EDITING",
  "FEATURE_GOVERNED_WORKFLOW",
  "FEATURE_INBOX_DOCUMENT_SCOUTS",
  "FEATURE_KNOWLEDGE_TEMPLATES",
  "FEATURE_LEGAL_LISTS",
  "FEATURE_MCP",
  "FEATURE_PUBLIC_LAW",
  "FEATURE_PUBLIC_TOOLS",
  "FEATURE_SHAREPOINT",
  "FEATURE_TEMPLATE_PACKS",
  "FEATURE_TIME_BILLING",
  "FEATURE_TODOS",
  "FEATURE_USAGE",
  "FEATURE_WEB_SEARCH",
  "FEEDBACK_INTAKE_URL",
  "FRONTEND_URL",
  "GOOGLE_AUTH_CLIENT_ID",
  "GOTENBERG_URL",
  "HOSTED_USAGE_PROVIDER",
  "HOSTED_USAGE_PROVIDER_BASE_URL",
  "HUGGINGFACE_BASE_URL",
  "LEGAL_CORPUS_S3_BUCKET",
  "LEGAL_SEARCH_INDEX_GENERATION",
  "LEGAL_SEARCH_PROVIDER",
  "MICROSOFT_AUTH_CLIENT_ID",
  "MICROSOFT_AUTH_TENANT_ID",
  "PORT",
  "POSTHOG_HOST",
  "POSTHOG_KEY",
  "POSTHOG_LOCAL_DEBUG",
  "PUBLIC_URL",
  "QUERY_EXPANSION_MODE",
  "REPORT_SPECS_DIR",
  "REPORT_SPECS_S3_PREFIX",
  "REDIS_TLS_REJECT_UNAUTHORIZED",
  "REQUIRE_PERSONAL_AI_KEY",
  "S3_BUCKET",
  "S3_CREDENTIALS_PROVIDER",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_SCOPED_SIGNING_ROLE_ARN",
  "SELFHOST_LOCAL_PASSWORD_AUTH",
  "SES_CONFIGURATION_SET",
  "SES_REGION",
  "SKIP_MIGRATION_CHECK",
  "SMTP_HOST",
  "SMTP_PORT",
  "STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS",
  "STELLA_API_PORT",
  "STELLA_API_URL",
  "STELLA_COLLAB_MODE",
  "STELLA_COLLAB_PORT",
  "STELLA_COMMIT_SHA",
  "STELLA_OCR_PDF_FONT_PATH",
  "STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE",
  "STELLA_TRUSTED_PROXY_CIDRS",
  "STELLA_USAGE_POLICY_SEEDS",
  "STELLA_VERSION",
  "STELLA_WORKER_DIR",
  "STELLA_YARA_RULES_DIR",
  "TEMPLATE_PACKS_CONTENT_DIR",
  "USAGE_ENFORCEMENT_ENABLED",
  "USE_MOCK_AI",
  "WEB_FETCH_PROVIDER",
  "WEB_SEARCH_PROVIDER",
]);

const EXAMPLE_VALUES: Record<string, string> = {
  BETTER_AUTH_SECRET: "your-secret-at-least-32-chars-long",
  BETTER_AUTH_URL: "http://localhost:3001",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/stella",
  DB_HOST: "localhost",
  DB_NAME: "stella",
  DB_PASSWORD: "",
  DB_PORT: "5432",
  DB_SSLMODE: "require",
  DB_USER: "postgres",
  EMAIL_PROVIDER: "smtp",
  EDGAR_USER_AGENT: "stella admin@example.com",
  FEEDBACK_EMAIL_TO: "maintainer@example.com",
  FRONTEND_URL: "http://localhost:3000",
  GOOGLE_GENERATIVE_AI_API_KEY: "key-test",
  GOTENBERG_PASSWORD: "gotenberg",
  GOTENBERG_URL: "http://localhost:3003",
  GOTENBERG_USERNAME: "gotenberg",
  MICROSOFT_AUTH_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  POSTHOG_KEY: "phc_",
  POSTHOG_HOST: "https://eu.i.posthog.com",
  PUBLIC_URL: "http://localhost:3001",
  REDIS_URL: "redis://localhost:6379",
  S3_ACCESS_KEY_ID: "stella-rustfs-dev",
  S3_BUCKET: "stella",
  S3_CREDENTIALS_PROVIDER: "auto",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_SECRET_ACCESS_KEY: "stella-rustfs-dev-secret",
  SMTP_HOST: "localhost",
  SMTP_PASSWORD: "",
  SMTP_PORT: "1025",
  SMTP_USERNAME: "",
  STELLA_API_URL: "http://localhost:3001",
  STELLA_COLLAB_MODE: "single-process",
  STELLA_COLLAB_PORT: "3002",
  STELLA_COLLAB_REDIS_URL: "redis://localhost:6379",
  STELLA_COLLAB_SERVICE_TOKEN: "local-collab-service-token-at-least-32-chars",
  STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE: "direct",
  STELLA_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
  TRANSACTIONAL_EMAIL_FROM: "noreply@example.com",
  USE_MOCK_AI: "true",
  VITE_API_URL: "http://localhost:3001",
  VITE_BROWSER_API_URL: "http://localhost:3000/api",
  VITE_COLLAB_URL: "ws://localhost:3002",
  VITE_FEEDBACK_EMAIL_TO: "ops@example.com",
  VITE_POSTHOG_KEY: "phc_",
  VITE_POSTHOG_HOST: "https://eu.i.posthog.com",
  VITE_POSTHOG_UI_HOST: "https://eu.posthog.com",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
};

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  AGENT_SANDBOX_DOCKER_NETWORK:
    "Locked-down Docker network used by agent sandboxes. It must deny arbitrary egress.",
  AGENT_SANDBOX_DOCKER_SOCKET:
    "Docker daemon socket used to create agent sandboxes. Defaults to the platform Docker socket.",
  AGENT_SANDBOX_HARNESS_API_KEY:
    "Model-provider credential delegated only to the isolated agent harness.",
  AGENT_SANDBOX_HARNESS_BASE_URL:
    "OpenAI-compatible endpoint used by the isolated agent harness.",
  AGENT_SANDBOX_HARNESS_MODEL:
    "Model identifier used by the isolated agent harness.",
  AGENT_SANDBOX_IMAGE: "Container image used for isolated agent runs.",
  AGENT_SANDBOX_MCP_URL:
    "Container-reachable MCP endpoint used by isolated agent runs.",
  AGENT_SANDBOX_RUNS_ENABLED:
    "Enable explicit agent-mode chat requests for this deployment.",
  BETTER_AUTH_SECRET:
    "HMAC secret used to sign Better Auth sessions. Use at least 32 characters; rotation logs everyone out.",
  BETTER_AUTH_URL:
    "Issuer URL Better Auth uses to mint and verify session tokens.",
  COMPANIES_HOUSE_API_KEY:
    "UK Companies House API key. Unset disables the adapter.",
  CONTENT_ENCRYPTION_KEY:
    "64-character hex AES key for extracted file text at rest. Local development may omit it.",
  DATABASE_POOL_IDLE_TIMEOUT_S:
    "Idle database connection lifetime in seconds; zero disables retirement.",
  DATABASE_POOL_MAX_LIFETIME_S:
    "Maximum database connection lifetime in seconds; zero disables retirement.",
  DATABASE_RLS_POOL_MAX:
    "Maximum RLS pool size. Keep its sum with DATABASE_ROOT_POOL_MAX within the process connection budget.",
  DATABASE_ROOT_POOL_MAX:
    "Maximum root pool size. Keep its sum with DATABASE_RLS_POOL_MAX within the process connection budget.",
  PUBLIC_LAW_DATABASE_POOL_MAX:
    "Maximum connections in the optional local read-only public-law pool.",
  PUBLIC_LAW_DATABASE_URL:
    "Local-development-only read-only Postgres URL for the shared public-law corpus. Unset uses DATABASE_URL.",
  CORPUS_INDEX_BACKPRESSURE_DIMENSIONS:
    "Name=Value[,Name=Value...] dimensions of the pacing metric.",
  CORPUS_INDEX_BACKPRESSURE_HIGH_WATERMARK:
    "Metric value above which a paused corpus-index build resumes.",
  CORPUS_INDEX_BACKPRESSURE_LOW_WATERMARK:
    "Metric value below which the corpus-index build loop pauses.",
  CORPUS_INDEX_BACKPRESSURE_METRIC:
    "CloudWatch metric name the corpus-index build loop samples to pace itself. Unset disables pacing.",
  CORPUS_INDEX_BACKPRESSURE_NAMESPACE:
    "CloudWatch namespace of the pacing metric.",
  CORPUS_INDEX_BACKPRESSURE_SAMPLE_INTERVAL_MS:
    "Minimum interval between pacing-metric samples.",
  CORPUS_INDEX_Q09_ENDPOINT:
    "Isolated Quickwit 0.9 mutation endpoint. Final generations registered on q09 use this endpoint; it never falls back to the legacy cluster.",
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT:
    "Local-development-only read endpoint for Quickwit 0.9. Unset uses CORPUS_INDEX_Q09_ENDPOINT; never used for mutations.",
  CORPUS_INDEX_SEARCH_ENDPOINT:
    "Local-development-only search endpoint for a shared corpus index. Unset uses CORPUS_INDEX_ENDPOINT; this endpoint is never used for index mutations.",
  DATABASE_URL:
    "Postgres owner URL used by Drizzle. Requests downgrade to the stella role so row-level security applies.",
  DB_HOST:
    "Postgres hostname used with the component settings when DATABASE_URL is unset.",
  DB_NAME:
    "Postgres database name used with the component settings when DATABASE_URL is unset.",
  DB_PASSWORD:
    "Postgres password used with the component settings when DATABASE_URL is unset.",
  DB_PORT:
    "Postgres port used with the component settings when DATABASE_URL is unset.",
  DB_SSLMODE:
    "TLS mode for component database settings: require, verify-ca, or verify-full.",
  DB_USER:
    "Postgres user used with the component settings when DATABASE_URL is unset.",
  DOCUMENT_OCR_BATCH_INTERVAL_MINUTES:
    "Interval for releasing queued OCR requests, in minutes.",
  DOCUMENT_OCR_MODEL_DIR:
    "Directory holding the local OCR models; populate it with `bun run ocr:fetch-models`.",
  DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES:
    "Batch mode: the document-processing worker exits once its queue has stayed empty this many minutes. Unset keeps it long-running.",
  EDGAR_USER_AGENT:
    "Identifying SEC EDGAR contact string. Unset disables the adapter because the SEC requires one.",
  EMAIL_PROVIDER:
    'Transactional email transport: "ses" or "smtp". Leave unset when email is not configured.',
  FEATURE_AI_MEMORY:
    "Enable tenant-scoped AI memory APIs, prompt retrieval, tools, and workers.",
  FEATURE_INBOX_DOCUMENT_SCOUTS:
    "Enable model-backed inbox producers that read processed documents and review runs.",
  FEATURE_GOVERNED_WORKFLOW:
    "Enable governed work obligations and task workflow semantics.",
  FEATURE_LEGAL_LISTS:
    "Enable first-class legal lists across REST, agents, and task UI.",
  FEATURE_PUBLIC_TOOLS:
    "Enable GitHub-sourced public skills in the authenticated catalogue.",
  FEATURE_TEMPLATE_PACKS:
    "Offer the bundled template-pack catalogue. Off until a deployment opts in; its routes do not exist while off.",
  FEEDBACK_EMAIL_TO:
    "Destination for MCP and public-intake feedback email. Unset disables local email delivery.",
  FEEDBACK_INTAKE_URL:
    "Endpoint for approved, sanitized feedback forwarded through the stella channel.",
  FRONTEND_URL:
    "Web app origin used for absolute transactional-email links and trusted redirects.",
  GOOGLE_AUTH_CLIENT_ID:
    "Google OAuth client ID; required when the matching web login flag is enabled.",
  GOOGLE_AUTH_CLIENT_SECRET:
    "Google OAuth client secret; required when the matching web login flag is enabled.",
  GOTENBERG_PASSWORD:
    "Password for the Gotenberg sidecar's HTTP basic authentication.",
  GOTENBERG_URL:
    "Gotenberg document-conversion URL. A deployed environment requires " +
    "HTTPS, a loopback sidecar, or a private deployment network.",
  GOTENBERG_USERNAME:
    "Username for the Gotenberg sidecar's HTTP basic authentication.",
  MICROSOFT_AUTH_CLIENT_ID:
    "Microsoft OAuth client ID; required when the matching web login flag is enabled.",
  MICROSOFT_AUTH_CLIENT_SECRET:
    "Microsoft OAuth client secret; required when the matching web login flag is enabled.",
  MICROSOFT_AUTH_TENANT_ID:
    "Microsoft OAuth tenant selector accepted by the configured application registration.",
  OPERATOR_METRICS_TOKEN:
    "Bearer token for registration metrics. Unset disables the endpoint; use a long random value.",
  POSTHOG_KEY:
    'PostHog project key. The placeholder "phc_" disables capture for local development.',
  POSTHOG_LOCAL_DEBUG:
    "Allow PostHog capture from localhost when using a real project key.",
  PUBLIC_URL:
    "Public API origin for verification links and OAuth callbacks. Defaults to BETTER_AUTH_URL.",
  QUERY_EXPANSION_MODE:
    'Morphological expansion of case-law search terms: "off" builds today\'s query, "shadow" runs the unexpanded query and records leaf counts comparing it with the expanded one (never the query text). "on" runs the expanded query; a search cursor names the dictionary its page used, so a continuation built against another one is rejected as invalid.',
  REDIS_TLS_REJECT_UNAUTHORIZED:
    "Whether a rediss:// connection verifies the server certificate chain. " +
    "Leave on unless the endpoint presents a certificate no trust anchor can " +
    "validate and the private network is the boundary instead.",
  REDIS_URL:
    "Valkey or Redis URL used for cross-instance broadcasts and rate limits. Treated as secret because it may contain credentials.",
  S3_ACCESS_KEY_ID:
    'S3 access-key ID. Required with S3_CREDENTIALS_PROVIDER="env"; otherwise omit it with the secret to use the selected provider.',
  S3_BUCKET: "S3 bucket for uploaded files.",
  S3_CREDENTIALS_PROVIDER:
    'Credential source: "auto", "env", "aws-runtime", or "none".',
  S3_ENDPOINT: "S3 or S3-compatible object-storage endpoint.",
  S3_REGION: "S3 region for uploaded files and request signing.",
  S3_SCOPED_SIGNING_ROLE_ARN:
    "IAM role used to issue presigned URLs scoped to an organization or workspace prefix.",
  S3_SECRET_ACCESS_KEY:
    'S3 secret access key. Required with S3_CREDENTIALS_PROVIDER="env"; otherwise omit it with the access-key ID.',
  SECURITY_CANARY_API_KEY_SHA256:
    "SHA-256 digest of a decoy machine API key. Keep its plaintext outside this environment.",
  SES_REGION: "AWS region used for SES transactional email delivery.",
  SMTP_HOST: "SMTP relay hostname.",
  SMTP_PORT: "SMTP relay port.",
  SELFHOST_BOOTSTRAP_TOKEN:
    "One-time token required for the first local-password account.",
  SELFHOST_LOCAL_PASSWORD_AUTH:
    "Enable email/password auth for self-hosting. Initial signup also requires a bootstrap token.",
  SMTP_PASSWORD:
    "SMTP password. Set together with SMTP_USERNAME, or leave both empty for an unauthenticated relay.",
  SMTP_USERNAME:
    "SMTP username. Set together with SMTP_PASSWORD, or leave both empty for an unauthenticated relay.",
  STELLA_API_URL:
    "API origin used by collaboration to validate room tokens and persist Yjs snapshots.",
  STELLA_COLLAB_MODE:
    'Collaboration topology: "redis" for cross-replica broadcast or "single-process" for local development only.',
  STELLA_COLLAB_PORT: "Port for the Hocuspocus collaboration server.",
  STELLA_COLLAB_REDIS_URL:
    "Redis URL used for cross-replica Yjs and awareness broadcast. Treated as secret because it may contain credentials.",
  STELLA_COLLAB_SERVICE_TOKEN:
    "Bearer credential used by the collaboration service for snapshot load and store requests.",
  STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE:
    'Client-IP source for signup limits. Use "direct" without a proxy and "trusted_proxy" behind configured proxies.',
  STELLA_TRUSTED_PROXY_CIDRS:
    "Comma-separated CIDRs for proxies directly in front of the API. Never trust public client ranges.",
  STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS:
    "Comma-separated user IDs allowed to publish in-app announcements. Unset disables the endpoint for everyone.",
  REPORT_SPECS_DIR:
    "Absolute directory of extra report specs (one <key>/spec.json per subdirectory). A key here overrides the bundled spec of the same name.",
  REPORT_SPECS_S3_PREFIX:
    "s3://bucket/prefix/ of extra report specs in the REPORT_SPECS_DIR layout, read once at boot. Exclusive with REPORT_SPECS_DIR.",
  TEMPLATE_PACKS_CONTENT_DIR:
    "Directory holding the template-pack content. Set by the container image; unset in a source tree.",
  TRANSACTIONAL_EMAIL_FROM:
    "Verified sender address used for every transactional email.",
  USE_MOCK_AI:
    "Return canned AI responses in local development and tests. Deployed runtimes reject this setting.",
  VITE_API_URL: "API base URL used by the SPA for Eden treaty requests.",
  VITE_BROWSER_API_URL:
    "Same-origin browser API mount. Must be the exact /api path on VITE_PUBLIC_APP_URL; unset uses VITE_API_URL.",
  VITE_AUTH_GOOGLE:
    "Show Google login only when the API has matching OAuth credentials.",
  VITE_AUTH_MICROSOFT:
    "Show Microsoft login only when the API has matching OAuth credentials.",
  VITE_COLLAB_URL:
    "WebSocket URL for collaborative editing. Unset keeps the single-user editing path.",
  VITE_FEEDBACK_EMAIL_TO:
    "Recipient for the in-app feedback button. Unset hides the button.",
  VITE_BETA_FEATURES_ENABLED:
    "Expose Settings → Beta features without enabling any preview by default.",
  VITE_FEATURE_AI_MEMORY: "Show tenant-scoped AI memory settings.",
  VITE_FEATURE_GOVERNED_WORKFLOW:
    "Show governed work-obligation fields on a task (owner, acknowledgement, hard deadline).",
  VITE_FEATURE_INBOX:
    "Show the Inbox and the notification bell for everyone, without the per-browser beta toggle.",
  VITE_FEATURE_LEGAL_LISTS:
    "Show first-class legal lists and list-item task controls.",
  VITE_GUIDES_ENABLED: "Show the in-app interactive guides.",
  VITE_POSTHOG_KEY:
    'Public PostHog project key. The placeholder "phc_" disables local capture.',
  VITE_POSTHOG_LOCAL_DEBUG:
    "Allow browser PostHog capture from localhost when using a real key.",
  VITE_PUBLIC_APP_URL:
    "Public web origin used for canonical URLs, Open Graph metadata, and sitemaps.",
  VITE_SELFHOST: "Enable the release-update notice for self-hosted operators.",
  VITE_SEO_INDEXABLE: "Allow search engines to index this deployment.",
  VITE_TERMS_URL: "Absolute or root-relative Terms of Service link.",
};

const CONDITIONAL_REQUIREMENT_NOTES: Record<string, string> = {
  AGENT_SANDBOX_DOCKER_NETWORK: "AGENT_SANDBOX_RUNS_ENABLED is true",
  AGENT_SANDBOX_HARNESS_API_KEY: "AGENT_SANDBOX_RUNS_ENABLED is true",
  AGENT_SANDBOX_HARNESS_MODEL: "AGENT_SANDBOX_RUNS_ENABLED is true",
  AGENT_SANDBOX_IMAGE: "AGENT_SANDBOX_RUNS_ENABLED is true",
  AGENT_SANDBOX_MCP_URL: "AGENT_SANDBOX_RUNS_ENABLED is true",
  CONTENT_ENCRYPTION_KEY: "NODE_ENV is production or staging",
  CORPUS_INDEX_SEARCH_ENDPOINT:
    "LEGAL_SEARCH_PROVIDER is corpus-index and CORPUS_INDEX_ENDPOINT is unset",
  CORPUS_INDEX_Q09_ENDPOINT:
    "CORPUS_INDEXING_ENABLED is true and LEGAL_SEARCH_INDEX_GENERATION is case_law_v5",
  CORPUS_PROJECTION_OWNER: "CORPUS_STORAGE_MODE is canonical",
  LEGAL_CORPUS_S3_BUCKET: "corpus storage is enabled in a deployed environment",
  MICROSOFT_AUTH_TENANT_ID: "Microsoft OAuth credentials are configured",
  S3_ACCESS_KEY_ID: 'S3_CREDENTIALS_PROVIDER is "env"',
  S3_SECRET_ACCESS_KEY: 'S3_CREDENTIALS_PROVIDER is "env"',
  SES_REGION: "EMAIL_PROVIDER is ses",
  SMTP_HOST: "EMAIL_PROVIDER is smtp",
  SMTP_PORT: "EMAIL_PROVIDER is smtp",
  TRANSACTIONAL_EMAIL_FROM: "EMAIL_PROVIDER is ses or smtp",
};

const ACTIVE_EXAMPLE_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "DATABASE_ROOT_POOL_MAX",
  "DATABASE_RLS_POOL_MAX",
  "DATABASE_URL",
  "DOCUMENT_OCR_BATCH_INTERVAL_MINUTES",
  "EMAIL_PROVIDER",
  "FRONTEND_URL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOTENBERG_PASSWORD",
  "GOTENBERG_URL",
  "GOTENBERG_USERNAME",
  "POSTHOG_KEY",
  "REDIS_URL",
  "S3_ACCESS_KEY_ID",
  "S3_BUCKET",
  "S3_CREDENTIALS_PROVIDER",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_SCOPED_SIGNING_ROLE_ARN",
  "S3_SECRET_ACCESS_KEY",
  "SMTP_HOST",
  "SMTP_PASSWORD",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "STELLA_COLLAB_SERVICE_TOKEN",
  "STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE",
  "TRANSACTIONAL_EMAIL_FROM",
  "USE_MOCK_AI",
  "VITE_API_URL",
  "VITE_POSTHOG_KEY",
  "VITE_PUBLIC_APP_URL",
]);

const HIDDEN_SCHEMA_KEYS = new Set([
  "CASE_LAW_DATABASE_POOL_MAX",
  "CASE_LAW_DATABASE_URL",
  "isDev",
]);

const humanizeEnvName = (name: string) => {
  const words = name
    .replace(/^VITE_/u, "")
    .split("_")
    .map((word) => word.toLocaleLowerCase("en-US"));
  const text = words.join(" ");
  return `${text.charAt(0).toLocaleUpperCase("en-US")}${text.slice(1)}.`;
};

const sectionFor = (name: string) => {
  if (/^(DATABASE|DB_|STELLA_WORKER|SKIP_MIGRATION)/u.test(name)) {
    return "Database";
  }
  if (/^(S3|CORPUS|LEGAL_)/u.test(name)) {
    return "Storage and legal search";
  }
  if (/^(POSTHOG|DEBUG_)/u.test(name)) {
    return "Observability";
  }
  if (
    /^(AI_|GOOGLE_.*AI|OPENAI|OPENROUTER|AZURE_|ANTHROPIC|BEDROCK|MISTRAL|HUGGINGFACE|REQUIRE_PERSONAL|USE_MOCK)/u.test(
      name,
    )
  ) {
    return "AI providers";
  }
  if (
    /^(BETTER_AUTH|GOOGLE_AUTH|MICROSOFT_AUTH|SELFHOST|SECURITY_CANARY)/u.test(
      name,
    )
  ) {
    return "Authentication";
  }
  if (/^(EMAIL|SES_|SMTP_|TRANSACTIONAL|FEEDBACK)/u.test(name)) {
    return "Email and feedback";
  }
  if (
    /^(FEATURE_|VITE_FEATURE|VITE_PUBLIC_LAW|VITE_PLAYBOOKS|VITE_WORKFLOWS|VITE_SEO)/u.test(
      name,
    )
  ) {
    return "Feature flags";
  }
  if (/^(OCR_|CONTENT_ENCRYPTION|DOCUMENT_)/u.test(name)) {
    return "Document processing";
  }
  if (/^(HOSTED_USAGE|USAGE_|STELLA_USAGE)/u.test(name)) {
    return "Usage";
  }
  if (/^(WEB_|TAVILY|JINA|EDGAR|COMPANIES|INEGI|INGESTION)/u.test(name)) {
    return "External data";
  }
  if (/^(VITE_POSTHOG)/u.test(name)) {
    return "Analytics";
  }
  if (
    /^(FRONTEND|PUBLIC_URL|EXTENSION|GOTENBERG|VITE_API|VITE_PUBLIC|VITE_COLLAB|VITE_TERMS|VITE_EMPTY|VITE_DESKTOP_RELEASES)/u.test(
      name,
    )
  ) {
    return "URLs";
  }
  if (/^(STELLA_TRUSTED|STELLA_SIGNUP)/u.test(name)) {
    return "Network";
  }
  return "Runtime";
};

export const requirementFor = (schema: v.GenericSchema): EnvRequirement => {
  if (schema.type !== "optional") {
    return ENV_REQUIREMENT.required;
  }
  if ("default" in schema && schema.default !== undefined) {
    return ENV_REQUIREMENT.defaulted;
  }
  return ENV_REQUIREMENT.optional;
};

const exposureFor = (name: string, owner: EnvOwner): EnvExposure => {
  if (owner === ENV_OWNER.web) {
    return ENV_EXPOSURE.public;
  }
  if (INTERNAL_SERVER_KEYS.has(name)) {
    return ENV_EXPOSURE.internal;
  }
  return ENV_EXPOSURE.secret;
};

type CreateCatalogEntriesOptions = {
  owner: EnvOwner;
  schema: SchemaRecord;
};

const createCatalogEntries = ({ owner, schema }: CreateCatalogEntriesOptions) =>
  Object.entries(schema).map(([name, entrySchema]): EnvCatalogEntry => {
    const requirementNote = CONDITIONAL_REQUIREMENT_NOTES[name];
    return {
      description: DESCRIPTION_OVERRIDES[name] ?? humanizeEnvName(name),
      documented: !HIDDEN_SCHEMA_KEYS.has(name),
      example: EXAMPLE_VALUES[name],
      exposure: exposureFor(name, owner),
      name,
      owner,
      requirement: requirementNote
        ? ENV_REQUIREMENT.conditional
        : requirementFor(entrySchema),
      requirementNote,
      schema: entrySchema,
      section: sectionFor(name),
    };
  });

export const ENV_CATALOG = [
  ...createCatalogEntries({
    owner: ENV_OWNER.apiBase,
    schema: envBaseServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiBase,
    schema: databaseComponentEnvSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.documentWorker,
    schema: envDocumentProcessingWorkerServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiServer,
    schema: envApiServerSchema,
  }),
  ...createCatalogEntries({ owner: ENV_OWNER.web, schema: envWebClientSchema }),
  ...createCatalogEntries({
    owner: ENV_OWNER.collab,
    schema: envCollabServerSchema,
  }),
];

export const API_ENV_SCHEMA = {
  ...envBaseServerSchema,
  ...envDocumentProcessingWorkerServerSchema,
  ...envApiServerSchema,
};

export type ApiEnvironmentName = Exclude<keyof typeof API_ENV_SCHEMA, "isDev">;

export const WEB_ENV_SCHEMA = envWebClientSchema;
export const COLLAB_ENV_SCHEMA = envCollabServerSchema;

export const isActiveExampleEntry = (name: string) =>
  ACTIVE_EXAMPLE_KEYS.has(name);

export const MANUAL_SCHEMA_KEYS = new Set([
  "CASE_LAW_CITATION_RESOLUTION_ENABLED",
  "CASE_LAW_RECONCILIATION_ENABLED",
  "CITATION_AUTHORITY_BATCH_DELAY_MS",
  "CITATION_AUTHORITY_BATCH_SIZE",
  "CITATION_RESOLUTION_BATCH_DELAY_MS",
  "CITATION_RESOLUTION_BATCH_SIZE",
  "DEV",
  "DB_BACKFILL_TRANSACTION_TIMEOUT_MS",
  "DB_ROOT_QUERY_TIMEOUT_MS",
  "DB_TRANSACTION_TIMEOUT_MS",
  "DISABLED_ADAPTERS",
  "HOME",
  "MAX_CONCURRENT_ADAPTER_CYCLES",
  "MAX_CONCURRENT_DB_WRITES",
  "RECONCILIATION_FETCH_DELAY_MS",
  "SK_DOCUMENT_BACKFILL_ENABLED",
  "SK_DOCUMENT_FETCH_DELAY_MS",
  "STELLA_API_KEY",
  "STELLA_DESKTOP_ALLOWED_API_BASE_URLS",
  "STELLA_DESKTOP_ALLOWED_ORIGINS",
  "STELLA_DESKTOP_BRIDGE_PORT",
  "STELLA_DESKTOP_DEFAULT_API_BASE_URLS",
  "STELLA_DESKTOP_DEFAULT_ORIGINS",
  "STELLA_DESKTOP_TELEMETRY_LOCAL_DEBUG",
  "STELLA_DESKTOP_VIEW_PORT",
  "STELLA_ENABLE_DEBUG_CLIPBOARD_PERSISTENCE",
  "STELLA_OPEN_CLIPBOARD_ON_LAUNCH",
  "STELLA_SEED_EMAIL_WORKSPACE_ID",
  "STELLA_SERVER_URL",
  "STELLA_WEB_PORT",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "SSR",
]);

export const DEPLOYMENT_ENV_KEYS = new Set([
  "BUILDPLATFORM",
  "GOTENBERG_API_BASIC_AUTH_PASSWORD",
  "GOTENBERG_API_BASIC_AUTH_USERNAME",
  "POSTHOG_SOURCEMAP_PROJECT_ID",
  "POSTHOG_SOURCEMAP_PUBLISH",
  "PUBLIC_API_URL",
  "PUBLIC_APP_URL",
  "PUBLIC_BROWSER_API_URL",
  "PUBLIC_FEEDBACK_EMAIL_TO",
  "PUBLIC_GOOGLE_LOGIN_ENABLED",
  "PUBLIC_LAW_ENABLED",
  "PUBLIC_LAW_INDEXING_ENABLED",
  "PUBLIC_MICROSOFT_LOGIN_ENABLED",
  "PUBLIC_POSTHOG_HOST",
  "PUBLIC_POSTHOG_UI_HOST",
  "PUBLIC_POSTHOG_TOKEN",
  "PUBLIC_TOOLS_ENABLED",
  "PUBLIC_TOOLS_INDEXING_ENABLED",
  "SEO_INDEXABLE",
  "STELLA_API_CPUS",
  "STELLA_API_ENV_FILE",
  "STELLA_API_HOST_PORT",
  "STELLA_API_IMAGE",
  "STELLA_API_MEM_LIMIT",
  "STELLA_API_PIDS_LIMIT",
  "STELLA_DOCUMENT_PROCESSING_WORKER_CPUS",
  "STELLA_DOCUMENT_PROCESSING_WORKER_MEM_LIMIT",
  "STELLA_DOCUMENT_PROCESSING_WORKER_PIDS_LIMIT",
  "STELLA_GOTENBERG_CPUS",
  "STELLA_GOTENBERG_HOST_PORT",
  "STELLA_GOTENBERG_MEM_LIMIT",
  "STELLA_GOTENBERG_PIDS_LIMIT",
  "STELLA_OCR_CPUS",
  "STELLA_OCR_IMAGE",
  "STELLA_OCR_MEM_LIMIT",
  "STELLA_OCR_PIDS_LIMIT",
  "STELLA_OCR_SHM_SIZE",
  "STELLA_OCR_TMPFS_SIZE",
  "STELLA_PG_HOST_PORT",
  "STELLA_QUICKWIT_GRPC_PORT",
  "STELLA_QUICKWIT_Q09_GRPC_PORT",
  "STELLA_QUICKWIT_Q09_REST_PORT",
  "STELLA_QUICKWIT_REST_PORT",
  "STELLA_RUSTFS_CONSOLE_PORT",
  "STELLA_RUSTFS_HOST_PORT",
  "STELLA_VALKEY_HOST_PORT",
  "TARGETARCH",
  "TARGETPLATFORM",
  "TEXT_DETECTION_MODEL_SHA256",
  "TEXT_DETECTION_MODEL_URL",
  "TEXT_RECOGNITION_MODEL_SHA256",
  "TEXT_RECOGNITION_MODEL_URL",
  "VIRTUAL_ENV",
  "VITE_FEATURE_TIME_BILLING",
]);

export const TOOLING_ENV_KEYS = new Set([
  "AGENT_ENGINE_DOCKER_CANARY_URL",
  "AGENT_ENGINE_DOCKER_IMAGE",
  "AGENT_ENGINE_DOCKER_NETWORK",
  "AGENT_ENGINE_DOCKER_TEST",
  "AGENT_HARNESS_BASE_URL",
  "AGENT_SANDBOX_MODEL",
  "AGENT_SANDBOX_NETWORK",
  "AI_BENCH_JSON",
  "AI_BENCH_MODEL",
  "AI_BENCH_REPEATS",
  "AI_BENCH_SURFACE",
  "AI_CANARY_API_KEY",
  "ANALYZE",
  "API_DEPLOYMENT_ATTEMPTS",
  "API_DEPLOYMENT_DELAY_MS",
  "API_DEPLOYMENT_EXPECTED_COMMIT",
  "API_DEPLOYMENT_PROBE_PATH",
  "API_DEPLOYMENT_STABLE_PROBES",
  "API_DEPLOYMENT_URL",
  "APP_VERSION",
  "BASE_REF",
  "CANARY_PORT",
  "CANARY_PROBE_TOKEN",
  "CANARY_SERVER_URL",
  "CANARY_SIGNING_SECRET",
  "CANARY_STATE_PATH",
  "CODEX_API_KEY",
  "DEV_API_PROXY_TARGET",
  "DEV_LINKED_PACKAGE_ROOTS",
  "E2E_API_URL",
  "E2E_EDGE_HEADER_NAME",
  "E2E_EDGE_HEADER_VALUE",
  "E2E_EXECUTION_PROFILE",
  "E2E_EXPECT_DEV_ROUTES",
  "E2E_LANDING_URL",
  "E2E_NETWORK_BASELINE",
  "E2E_WEB_URL",
  "EXPECTED_COMMIT",
  "LANDING_SITE",
  "MARKETING_CAPTURE",
  "MARKETING_COMMIT",
  "MARKETING_THEME",
  "MATTER_ACTIVITY_USER_ID",
  "MATTER_ACTIVITY_WORKSPACE_ID",
  "MCP_APP_INPUT",
  "MCP_CANARY_BASE_URL",
  "MCP_CANARY_TOKEN",
  "NETWORK_CANARY_URL",
  "PGLITE_TEST_SNAPSHOT",
  "PRODUCT_MEDIA_S3_BUCKET",
  "PROPERTY_ROLE_BACKFILL_BATCH_SIZE",
  "PROPERTY_TEST_NUM_RUNS_FACTOR",
  "PROPERTY_TEST_SEED",
  "PROPERTY_TEST_TIMEOUT_BASE_MS",
  "RAILWAY_API_TOKEN",
  "RAILWAY_PROJECT_TOKEN",
  "RAILWAY_SMOKE_API_URL",
  "RAILWAY_SMOKE_EXPECTED_COMMIT",
  "RAILWAY_SMOKE_WEB_URL",
  "RAILWAY_TEMPLATE_ENVIRONMENT",
  "RAILWAY_TEMPLATE_PROJECT_ID",
  "REHEARSAL_BASE_DATABASE_URL",
  "REHEARSAL_BASE_IMAGE_REPOSITORY",
  "REHEARSAL_BASE_REF",
  "REHEARSAL_DECISIONS",
  "REHEARSAL_MIGRATE_BUDGET_SECONDS",
  "REHEARSAL_PRODUCTION_READY_URL",
  "RELEASE_REF",
  "REPO",
  "SMOKE_API_URL",
  "SMOKE_TEST",
  "STELLA_COLLAB_TEST_REDIS_CONTAINER_ID",
  "STELLA_COLLAB_TEST_REDIS_URL",
  "STELLA_DESKTOP_RELEASE_API_PATH",
  "STELLA_DESKTOP_RELEASE_EXPECTED_TAG",
  "STELLA_DEV_INSTANCE",
  "STELLA_INFRA_OFFSET",
  "STELLA_PORT_OFFSET",
  "STELLA_RUN_POSTGRES_TESTS",
  "STELLA_SEED_ID_NAMESPACE",
  "STELLA_SEED_ORG_ID",
  "STELLA_SEED_USER_ID",
  "STELLA_TEST_LATEST_TAG",
  "STELLA_TEST_OMIT_ASSET",
  "TURBO_SCM_BASE",
]);

export const AMBIENT_ENV_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CARGO_PKG_VERSION",
  "CI",
  "GITHUB_TOKEN",
  "GH_REPO",
  "GH_TOKEN",
  "HOSTNAME",
  "NODE_ENV",
  "PATH",
  "RAILWAY_GIT_COMMIT_SHA",
  "TZ",
]);

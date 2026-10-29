import { panic } from "better-result";
import type * as v from "valibot";

import {
  databaseComponentEnvSchema,
  envBaseServerSchema,
} from "../apps/api/src/env-base-schema";
import { envDocumentProcessingWorkerServerSchema } from "../apps/api/src/env-document-processing-worker-schema";
import { euCompletionTickServerSchema } from "../apps/api/src/env-eu-completion";
import { envOnlineIndexServerSchema } from "../apps/api/src/env-online-index";
import { replayTickServerSchema } from "../apps/api/src/env-replay";
import { envApiServerSchema } from "../apps/api/src/env-schema";
import { rateLimitBudgetEnvSchema } from "../apps/api/src/lib/rate-limit/budget-config-schema";
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
  credentialKind: (typeof ENV_CREDENTIAL_KIND)[keyof typeof ENV_CREDENTIAL_KIND];
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
  ...Object.keys(rateLimitBudgetEnvSchema),
  "EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL",
  "EMAIL_EVENTS_QUEUE_URL",
  "EMAIL_EVENTS_TOPIC_ARN",
  "LIST_VERIFICATION_ACTIVE_RUNS_MAX",
  "LIST_VERIFICATION_DAILY_STARTS_MAX",
  "UNUSED_CLIENT_RETENTION_DAYS",
  "AGENT_REGISTRATION_DAILY_LIMIT",
  "OPEN_CLIENT_REGISTRATION_DAILY_LIMIT",
  "ACTION_ADMISSION_BACKGROUND_ORG_CONCURRENCY",
  "ACTION_ADMISSION_BACKGROUND_USER_CONCURRENCY",
  "ACTION_ADMISSION_LEASE_MS",
  "MCP_PUBLIC_READ_CALLER_CONCURRENCY",
  "ACTION_ADMISSION_ORG_CONCURRENCY",
  "ACTION_ADMISSION_USER_CONCURRENCY",
  "ACTION_REQUEST_MAX_BYTES",
  "ACTION_RESPONSE_MAX_BYTES",
  "ACTION_PAGE_SIZE_MAX",
  "MCP_READ_WINDOW_MS",
  "MCP_READ_WINDOW_MAX_ENTRIES",
  "MCP_READ_TENANT_ORG_BYTES",
  "MCP_READ_TENANT_USER_BYTES",
  "MCP_READ_PUBLIC_ORG_BYTES",
  "MCP_READ_PUBLIC_USER_BYTES",
  "MCP_CASE_LAW_SEARCH_GUIDANCE",
  "DATA_INVARIANT_CASE_LAW_CANARIES",
  "DATA_INVARIANT_CASE_LAW_DAILY_BANDS",
  "AGENT_CLIENT_STORAGE_V1_ENABLED",
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
  "TYPESAFE_MODEL",
  "AI_PROVIDER_BASE_URL",
  "APPLE_AUTH_CLIENT_ID",
  "APPLE_AUTH_KEY_ID",
  "APPLE_AUTH_TEAM_ID",
  "OPENROUTER_WIF_POLICY_ID",
  "OPENROUTER_FAST_TIER_WIF_POLICY_ID",
  "OPENROUTER_WIF_AUDIENCE",
  "OPENROUTER_WIF_STS_REGION",
  "AZURE_API_VERSION",
  "AZURE_BASE_URL",
  "AZURE_RESOURCE_NAME",
  "BETTER_AUTH_COOKIE_PREFIX",
  "BETTER_AUTH_URL",
  "CASE_LAW_DATABASE_POOL_MAX",
  "CASE_LAW_EU_COMPLETION_ENABLED",
  "CASE_LAW_EU_COMPLETION_KILL_SWITCH",
  "CASE_LAW_EU_COMPLETION_MODE",
  "CASE_LAW_EU_COMPLETION_MAX_ROWS",
  "CASE_LAW_REPLAY_ENABLED",
  "CASE_LAW_REPLAY_KILL_SWITCH",
  "CASE_LAW_REPLAY_DISABLED_SOURCES",
  "KILL_SWITCHES",
  "PUBLIC_LAW_DATABASE_POOL_MAX",
  "PUBLIC_CORPUS_RESERVED_CONNECTIONS",
  "PUBLIC_CORPUS_ASSUMED_REPLICAS",
  "PUBLIC_CORPUS_SEARCH_P95_SECONDS",
  "PUBLIC_CORPUS_AGGREGATE_P95_SECONDS",
  "PUBLIC_CORPUS_SITEMAP_P95_SECONDS",
  "PUBLIC_CORPUS_SEARCH_ADDRESS_MAX",
  "PUBLIC_CORPUS_SEARCH_GLOBAL_MAX",
  "PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX",
  "PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX",
  "CORPUS_INDEX_Q09_ENDPOINT",
  "CORPUS_INDEX_Q09_SEARCH_ENDPOINT",
  "CORPUS_INDEX_S3_BUCKET",
  "CORPUS_STORAGE_ENABLED",
  "MANAGED_PROVIDER_CHECK_INTERVAL_MS",
  "MANAGED_PROVIDER_CHECK_TIMEOUT_MS",
  "DATABASE_POOL_IDLE_TIMEOUT_S",
  "DATABASE_POOL_MAX_LIFETIME_S",
  "DATABASE_STATEMENT_TIMEOUT_MS",
  "DATABASE_RLS_POOL_MAX",
  "DATABASE_ROOT_POOL_MAX",
  "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER",
  "DB_LOAD_GATE_EBS_SIGNAL",
  ...Object.keys(envOnlineIndexServerSchema),
  "DB_HOST",
  "DB_NAME",
  "DB_PORT",
  "DB_USER",
  "DEBUG_UNREDACTED_ERRORS",
  "DEV_PUBLIC_LAW_CONNECT_COMMAND",
  "DOCUMENT_OCR_BATCH_INTERVAL_MINUTES",
  "DOCUMENT_OCR_MODEL_DIR",
  "DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES",
  "E2E_DISABLE_AUTH_RATE_LIMIT",
  "SCHEDULED_JOBS_MODE",
  "EXTENSION_ORIGIN",
  "FEATURE_ACTION_ADMISSION",
  "FEATURE_AGENT_ID_JAG",
  "FEATURE_AI_MEMORY",
  "FEATURE_FILE_USAGE_LIMITS",
  "FEATURE_FREE_TIER",
  "FEATURE_GOVERNED_WORKFLOW",
  "FEATURE_GENERATED_VIEWS",
  "FEATURE_INBOX_DOCUMENT_SCOUTS",
  "FEATURE_LEGAL_LISTS",
  "FEATURE_MANAGED_PROVIDER_CHECKS",
  "FEATURE_MCP_READ_FENCE",
  "FEATURE_ORG_ACCESS_STATE",
  "FEATURE_ORG_SERVICE_BUDGETS",
  "FEATURE_PUBLIC_LAW",
  "FEATURE_PUBLIC_KNOWLEDGE",
  "FEATURE_PUBLIC_TOOLS",
  "FEATURE_SHAREPOINT",
  "FEATURE_TEMPLATE_PACKS",
  "FEATURE_TIME_BILLING",
  "FEATURE_USAGE",
  "FEATURE_WEB_SEARCH",
  "FRONTEND_URL",
  "GOOGLE_AUTH_CLIENT_ID",
  "GOTENBERG_URL",
  "HOSTED_USAGE_PROVIDER_BASE_URL",
  "HUGGINGFACE_BASE_URL",
  "INBOUND_MAIL_BUCKET",
  "INBOUND_MAIL_DOMAIN",
  "INBOUND_MAIL_KEY_PREFIX",
  "INBOUND_MAIL_QUEUE_URL",
  "INBOUND_MAIL_TOPIC_ARN",
  "LEGAL_CORPUS_S3_BUCKET",
  "MICROSOFT_AUTH_CLIENT_ID",
  "MICROSOFT_AUTH_TENANT_ID",
  "ORG_EVALUATION_PERIOD_DAYS",
  "PORT",
  "POSTHOG_HOST",
  "POSTHOG_KEY",
  "PDF_SIGNING_TSA_URL",
  "PDF_SIGNING_TSA_URLS",
  "PDF_SIGNING_TSA_TRUST_PEM",
  "POSTHOG_LOCAL_DEBUG",
  "PUBLIC_URL",
  "REPORT_SPECS_DIR",
  "REPORT_SPECS_S3_PREFIX",
  "REDIS_TLS_REJECT_UNAUTHORIZED",
  "REQUIRE_PERSONAL_AI_KEY",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_SCOPED_SIGNING_ROLE_ARN",
  "SELFHOST_LOCAL_PASSWORD_AUTH",
  "SESSION_TOKEN_ROTATION_ENABLED",
  "SESSION_LIFETIME_CAP_ENABLED",
  "MCP_WEB_HANDOFF_MINT_ENABLED",
  "MCP_WEB_HANDOFF_TEXT_ENABLED",
  "MCP_WEB_HANDOFF_TEXT_SESSION_MAX_SECONDS",
  "SES_CONFIGURATION_SET",
  "SES_REGION",
  "STELLA_ALLOW_PRIVILEGED_DB_LOGIN_FOR_LOCAL_DEV",
  "SKIP_MIGRATION_CHECK",
  "SMTP_HOST",
  "SMTP_PORT",
  "STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS",
  "STELLA_API_PORT",
  "STELLA_API_URL",
  "STELLA_CLIENT_ADDRESS_HEADER",
  "STELLA_COLLAB_PORT",
  "STELLA_COMMIT_SHA",
  "STELLA_OCR_PDF_FONT_PATH",
  "STELLA_TRUSTED_PROXY_CIDRS",
  "STELLA_USAGE_POLICY_SEEDS",
  "STELLA_VERSION",
  "STELLA_WORKER_DIR",
  "STELLA_YARA_RULES_DIR",
  "TEMPLATE_PACKS_CONTENT_DIR",
  "USAGE_ENFORCEMENT_ENABLED",
  "USE_MOCK_AI",
  "VISUAL_PREVIEW_FUNCTION_NAME",
]);

const EXAMPLE_VALUES: Record<string, string> = {
  DEPLOY_ENVIRONMENT: "development",
  API_FEATURE_ACCESS_GRANTS: "{}",
  KILL_SWITCHES: "{}",
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
  EMAIL_EVENTS_QUEUE_URL:
    "https://sqs.eu-west-1.amazonaws.com/123456789012/ses-events",
  EMAIL_EVENTS_TOPIC_ARN:
    "arn:aws:sns:eu-west-1:123456789012:ses-notifications",
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL:
    "https://sqs.eu-west-1.amazonaws.com/123456789012/ses-events-dlq",
  INBOUND_MAIL_DOMAIN: "inbound.example.com",
  INBOUND_MAIL_QUEUE_URL:
    "https://sqs.eu-west-1.amazonaws.com/123456789012/inbound-mail",
  INBOUND_MAIL_TOPIC_ARN: "arn:aws:sns:eu-west-1:123456789012:inbound-mail",
  INBOUND_MAIL_BUCKET: "inbound-mail",
  INBOUND_MAIL_KEY_PREFIX: "mail/",
  EDGAR_USER_AGENT: "stella admin@example.com",
  INGESTION_USER_AGENT: "acme-ingestion/1.0 (+https://example.com/contact)",
  FEEDBACK_EMAIL_TO: "maintainer@example.com",
  FEEDBACK_GITHUB_REPO: "owner/repo",
  DB_LOAD_GATE_EBS_SIGNAL: "disabled",
  // Local and CI databases build indexes without wall-clock busy windows.
  DB_LOAD_GATE_BUSY_WINDOWS: "[]",
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
  STELLA_CLIENT_ADDRESS_HEADER: "cloudfront-viewer-address",
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
  VITE_POSTHOG_KEY: "phc_",
  VITE_POSTHOG_HOST: "https://eu.i.posthog.com",
  VITE_POSTHOG_UI_HOST: "https://eu.posthog.com",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
};

const requestBudgetUnitDescription = (name: string): string => {
  if (name.endsWith("_MS")) {
    return "milliseconds (1000–604800000)";
  }
  if (name.endsWith("_WINDOW_SECONDS")) {
    return "seconds (1–604800)";
  }
  if (name.endsWith("_MAX_CONCURRENT")) {
    return "concurrent requests (1–10000)";
  }
  return "requests per window (1–1000000)";
};

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  STELLA_ALLOW_PRIVILEGED_DB_LOGIN_FOR_LOCAL_DEV:
    "Unsafe local development opt-in: set to 1 only with an explicitly enabled local development runtime. Strict runtimes refuse this setting.",
  ...Object.fromEntries(
    Object.keys(rateLimitBudgetEnvSchema).map((name) => {
      const unit = requestBudgetUnitDescription(name);
      return [
        name,
        `Request budget ${name.replace("RATE_LIMIT_", "").toLowerCase().replaceAll("_", " ")}; ${unit}. Defaults are defined by the validated API schema.`,
      ];
    }),
  ),
  APP_REVIEW_ACCOUNT_EMAIL:
    "Restricted review account allowed password sign-in. Set together with APP_REVIEW_ORGANIZATION_ID.",
  APP_REVIEW_ORGANIZATION_ID:
    "Organization the restricted review account is confined to. Set together with APP_REVIEW_ACCOUNT_EMAIL.",
  FEATURE_GENERATED_VIEWS:
    "Enable generated views for callers granted access to the feature. Disabled by default.",
  VISUAL_PREVIEW_FUNCTION_NAME:
    "Optional Lambda function name for generated-view previews. Publishing remains available when previews are not configured.",
  LIST_VERIFICATION_ACTIVE_RUNS_MAX:
    "Maximum queued and running document verifications per organization (1–100; default 2).",
  LIST_VERIFICATION_DAILY_STARTS_MAX:
    "Maximum document verification starts per organization per Europe/Prague day (1–1000; default 20).",
  CASE_LAW_DERIVED_AI:
    'Model calls for case-law derived layers: "on" generates a missing decision analysis when a reader opens it and refreshes its significance from the citation graph; "off" (the default) serves stored analyses only, so local, seeded and CI stacks never reach a model by serving a decision.',
  CASE_LAW_EU_COMPLETION_ENABLED:
    "Enable bounded EU case-law completion. Defaults to false.",
  CASE_LAW_EU_COMPLETION_KILL_SWITCH:
    "Stop EU case-law completion before the next publisher or database effect.",
  CASE_LAW_EU_COMPLETION_MODE:
    "Completion mode: dry-run by default; apply requires durable supervised approval.",
  CASE_LAW_EU_COMPLETION_MAX_ROWS:
    "Maximum completion documents per invocation, from 1 to 100. Defaults to 25.",
  CASE_LAW_REPLAY_ENABLED:
    "Enable bounded background case-law replay. Defaults to false.",
  CASE_LAW_REPLAY_KILL_SWITCH:
    "Stop background case-law replay at the next batch boundary. Defaults to false.",
  CASE_LAW_REPLAY_DISABLED_SOURCES:
    "Comma-separated adapter keys excluded from background case-law replay.",
  KILL_SWITCHES:
    'Operator kill-switch overrides: a JSON object of switch id to "on" or "off", such as {"chat":"off"}. A switched-off feature refuses new work with a typed "turned off" refusal; restarting the running build applies a change. Switch ids live in apps/api/src/lib/kill-switches/registry.ts; an unknown id or state refuses startup.',
  UNUSED_CLIENT_RETENTION_DAYS:
    "Age in days before unused client registrations expire (1–365; default 30).",
  AGENT_REGISTRATION_DAILY_LIMIT:
    "Maximum agent registrations per UTC day (1–1000000; default 10000).",
  OPEN_CLIENT_REGISTRATION_DAILY_LIMIT:
    "Maximum open client registrations per UTC day (1–1000000; default 10000).",
  HOSTED_USAGE_WEBHOOK_RETENTION_DAYS:
    "Retention in days for completed provider event details; unset disables redaction.",
  AGENT_CLIENT_STORAGE_V1_ENABLED:
    "Enable the shared agent client storage format.",
  ACTION_LIMIT_CONTACT_URL:
    "Public http(s) contact link shown when an action is paused or not enabled.",
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
  DEPLOY_ENVIRONMENT:
    "Runtime deployment environment: production, staging, or development. Independent of NODE_ENV; unset events are excluded from production release health.",
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
  DATABASE_STATEMENT_TIMEOUT_MS:
    "Statement timeout in milliseconds set on each root and RLS pool connection; zero keeps the server default.",
  DATABASE_RLS_POOL_MAX:
    "Maximum RLS pool size. Keep its sum with DATABASE_ROOT_POOL_MAX, plus one connection for the periodic login check outside local development, within the process connection budget.",
  DATABASE_ROOT_POOL_MAX:
    "Maximum root pool size. Keep its sum with DATABASE_RLS_POOL_MAX, plus one connection for the periodic login check outside local development, within the process connection budget.",
  PUBLIC_CORPUS_RESERVED_CONNECTIONS:
    "Public corpus concurrent-work reservation when using the root pool. Unset reserves max(1, floor(DATABASE_ROOT_POOL_MAX / 4)); values are capped at the root pool size. A dedicated PUBLIC_LAW_DATABASE_URL uses its own pool limits.",
  PUBLIC_CORPUS_SEARCH_ADDRESS_MAX:
    "Statute and case-law full-text search requests per minute shared by one client address, capped at half the search global budget.",
  PUBLIC_LAW_DATABASE_POOL_MAX:
    "Maximum connections in the optional local read-only public-law pool.",
  PUBLIC_LAW_DATABASE_URL:
    "Local-development-only read-only Postgres URL for the shared public-law corpus. Unset uses DATABASE_URL.",
  CORPUS_INDEX_Q09_ENDPOINT: "Corpus index mutation endpoint.",
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT:
    "Corpus index read endpoint, accepted on a private corpus-index-v09 service host and otherwise only in local development. Unset uses CORPUS_INDEX_Q09_ENDPOINT; never used for mutations.",
  DATA_INVARIANT_CASE_LAW_CANARIES:
    'Case-law queries the corpus must answer, as a JSON array of {"country","query"} (at most 32). The hourly data-invariant run searches each and reports any that returns nothing. Unset or "[]" skips the check.',
  DATA_INVARIANT_CASE_LAW_DAILY_BANDS:
    'Expected published decisions per day for each ingestion adapter, as a JSON array of {"adapterKey","min","max"}. The hourly data-invariant run reports an enabled source outside its band. Unset or "[]" skips the check.',
  DATABASE_URL:
    "Postgres owner URL used by Drizzle. Requests downgrade to the stella role so row-level security applies.",
  DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER:
    "RDS instance whose EBS balances gate heavy maintenance and online index builds. Region and credentials use the AWS SDK provider chain. A set identifier enables EBS reads and takes precedence over DB_LOAD_GATE_EBS_SIGNAL. Missing or failed metrics defer maintenance.",
  DB_LOAD_GATE_EBS_SIGNAL:
    "Non-RDS, self-hosted and local databases must set `DB_LOAD_GATE_EBS_SIGNAL=disabled` to explicitly disable the EBS signal. The logged not_configured signal allows other health gates to govern maintenance. If neither setting is supplied, migrate fails before connecting, and background maintenance holds with an error event naming the missing configuration.",
  DB_LOAD_GATE_START_FLOOR:
    "EBS balance percentage required to start an online index build.",
  DB_LOAD_GATE_HARD_FLOOR:
    "EBS balance percentage below which a running online index build is cancelled and retried later.",
  DB_LOAD_GATE_MAX_STALENESS_MS:
    "Maximum age of a health reading before it counts as unknown and holds the build.",
  DB_LOAD_GATE_READ_TIMEOUT_MS:
    "Timeout for each health probe, including the online index observer's connection and statements.",
  DB_LOAD_GATE_MAX_HELD_MS:
    "How long an online index build may stay held before a held-too-long event is logged.",
  DB_LOAD_GATE_LONG_TX_MAX_AGE_MS:
    "Oldest open transaction age that still allows an online index build to start.",
  DB_LOAD_GATE_BUSY_WINDOWS:
    'JSON array of local busy windows, such as `[{"start":"06:30","end":"08:00","timeZone":"Europe/Prague"}]`, during which online index builds wait. `[]` disables them.',
  ONLINE_INDEX_POLL_MS:
    "Interval between health checks while an online index build runs.",
  ONLINE_INDEX_CLIENT_CHECK_MS:
    "client_connection_check_interval for the index build session, so a lost migrator stops its build.",
  ONLINE_INDEX_RETRY_MS:
    "Delay before the migrator retries a deferred online index build.",
  ONLINE_INDEX_MAX_SNAPSHOT_WAIT_MS:
    "Maximum time an online index build may stay in one waiting phase, such as waiting for older transactions, before it is cancelled and retried.",
  ONLINE_INDEX_IDLE_HOLDER_MS:
    "How long another session may sit idle in a transaction on a table before online index work on that table defers instead of starting.",
  ONLINE_INDEX_LONG_HOLDER_MS:
    "How old another session's transaction on a table may be before online index work on that table defers instead of starting.",
  ONLINE_INDEX_PARALLEL_WORKERS:
    "max_parallel_maintenance_workers for online index builds (0 or 1).",
  ONLINE_INDEX_MAINTENANCE_WORK_MEM_MB:
    "maintenance_work_mem, in megabytes, for online index builds.",
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
  DEV_PUBLIC_LAW_CONNECT_COMMAND:
    "Local-development-only executable the Dev menu runs to reach the corpus that PUBLIC_LAW_DATABASE_URL and CORPUS_INDEX_Q09_SEARCH_ENDPOINT name, for example by opening local tunnels. Unset disables the action.",
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
  EMAIL_EVENTS_QUEUE_URL:
    "SQS queue URL (https://sqs.<region>.amazonaws.com/<account>/<name>) subscribed to the mail provider's bounce and complaint topic, reached in the region it names. Set with the other EMAIL_EVENTS_* keys to mark undeliverable account addresses; unset disables it.",
  EMAIL_EVENTS_TOPIC_ARN:
    "SNS topic the mail provider publishes bounce and complaint events to; deliveries from any other topic are refused.",
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL:
    "Dead-letter queue of EMAIL_EVENTS_QUEUE_URL, in the same region; its depth is reported on every run.",
  INBOUND_MAIL_DOMAIN:
    "Dedicated catch-all domain for matter inbound addresses. Unset disables address creation.",
  INBOUND_MAIL_QUEUE_URL:
    "SQS queue URL (https://sqs.<region>.amazonaws.com/<account>/<name>) subscribed to the SES receipt topic, reached in the region it names. Set with the other INBOUND_MAIL_* transport keys to file inbound mail; unset disables receiving.",
  INBOUND_MAIL_TOPIC_ARN:
    "SNS topic the SES receipt rule publishes to. Queue messages from any other topic are left for the dead-letter queue.",
  INBOUND_MAIL_BUCKET:
    "S3 bucket the SES receipt rule stores raw messages in, in S3_REGION.",
  INBOUND_MAIL_KEY_PREFIX:
    "Object key prefix of the SES receipt rule's S3 action, for example mail/.",
  FEATURE_AI_MEMORY:
    "Enable tenant-scoped AI memory APIs, prompt retrieval, tools, and workers.",
  FEATURE_INBOX_DOCUMENT_SCOUTS:
    "Enable model-backed inbox producers that read processed documents and review runs.",
  FEATURE_GOVERNED_WORKFLOW:
    "Enable governed work obligations and task workflow semantics.",
  FEATURE_LEGAL_LISTS:
    "Enable first-class legal lists across REST, agents, and task UI.",
  API_FEATURE_ACCESS_GRANTS:
    "Operator-owned JSON object keyed by registered feature id. Member grants specify type, organizationId, and email; organization grants specify type and organizationId. Both require current membership and verified email. Unknown feature ids reject startup; empty grants hide invitation features.",
  FEATURE_ORG_ACCESS_STATE:
    "Enforce the per-organization access state before a model call falls back to the instance provider.",
  FEATURE_FREE_TIER:
    "Fall organizations whose evaluation or paid access lapsed back to the seeded free usage policy. Requires FEATURE_ORG_ACCESS_STATE and FEATURE_ORG_SERVICE_BUDGETS with USAGE_ENFORCEMENT_ENABLED off.",
  FEATURE_FILE_USAGE_LIMITS:
    "Enforce organization file byte reservations at storage writes.",
  OPENROUTER_WIF_POLICY_ID:
    "Workload-identity federation policy. Configure with audience and regional STS endpoint; a static key takes precedence.",
  OPENROUTER_FAST_TIER_WIF_POLICY_ID:
    "Workload-identity federation policy for fast-tier managed work. Shares the audience and regional STS endpoint; a fast-tier static key takes precedence.",
  OPENROUTER_FAST_TIER_API_KEY:
    "Managed OpenRouter key for fast-tier work. Never falls back to the standard key; required when the free tier runs on managed OpenRouter, unless the fast-tier federation policy is set.",
  OPENROUTER_WIF_AUDIENCE:
    "Audience for the workload-identity token. Required with the federation policy and STS region.",
  OPENROUTER_WIF_STS_REGION:
    "AWS region for workload-identity token minting. Required with the federation policy and audience.",
  FEATURE_MANAGED_PROVIDER_CHECKS:
    "Check regional model availability before managed requests. Requires AI_PROVIDER=openrouter, a static key or complete workload-identity configuration, and explicit check interval/timeout settings.",
  MANAGED_PROVIDER_CHECK_INTERVAL_MS:
    "Regional catalog refresh interval in milliseconds. Required when FEATURE_MANAGED_PROVIDER_CHECKS is enabled; must exceed the check timeout.",
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS:
    "Regional catalog check deadline in milliseconds, at most 30000. Required when FEATURE_MANAGED_PROVIDER_CHECKS is enabled.",
  ORG_EVALUATION_PERIOD_DAYS:
    "Length in days of the evaluation period a new organization starts.",
  FEATURE_PUBLIC_TOOLS:
    "Enable GitHub-sourced public skills in the authenticated catalogue.",
  FEATURE_TEMPLATE_PACKS:
    "Offer the bundled template-pack catalogue. Off until a deployment opts in; its routes do not exist while off.",
  FEATURE_PUBLIC_KNOWLEDGE:
    "Enable unauthenticated read-only endpoints for opted-in bundled knowledge content. Off by default.",
  FEEDBACK_EMAIL_TO:
    "Destination for maintainer feedback email. Unset disables email delivery.",
  FEEDBACK_GITHUB_REPO:
    "owner/repo that filed feedback is posted to as an issue. Requires FEEDBACK_GITHUB_TOKEN; unset disables GitHub delivery.",
  FEEDBACK_GITHUB_TOKEN:
    "Token used to file feedback issues in FEEDBACK_GITHUB_REPO. Needs issue-write scope only; unset disables GitHub delivery.",
  FRONTEND_URL:
    "Web app origin used for absolute transactional-email links, document verification links, and trusted redirects.",
  APPLE_AUTH_CLIENT_ID:
    "Sign in with Apple Services ID used as the OAuth client ID; required when the matching web login flag is enabled.",
  APPLE_AUTH_KEY_ID: "Key ID of the Sign in with Apple private key.",
  APPLE_AUTH_PRIVATE_KEY:
    "PEM text of the Sign in with Apple private key (.p8). The API mints the short-lived client secret from it.",
  APPLE_AUTH_TEAM_ID:
    "Apple Developer team ID that owns the Services ID and key.",
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
  INGESTION_USER_AGENT:
    "User-Agent sent to court publishers. Defaults to a stella product " +
    "identifier with the build version and a contact URL; set it so a fork " +
    "does not identify as the upstream project. Browser-like values are " +
    "refused by publishers that gate bots.",
  MCP_CASE_LAW_SEARCH_GUIDANCE:
    'Query guidance in the search_case_law tool: "off" keeps today\'s description, "v1" explains how phrasings are matched and how the limit is shared, names apex courts per admitted country, and warns when a long phrasing fills fewer slots than it was given.',
  MICROSOFT_AUTH_CLIENT_ID:
    "Microsoft OAuth client ID; required when the matching web login flag is enabled.",
  MICROSOFT_AUTH_CLIENT_SECRET:
    "Microsoft OAuth client secret; required when the matching web login flag is enabled.",
  MICROSOFT_AUTH_TENANT_ID:
    "Microsoft OAuth tenant selector accepted by the configured application registration.",
  POSTHOG_KEY:
    'PostHog project key. The placeholder "phc_" disables capture for local development.',
  POSTHOG_LOCAL_DEBUG:
    "Allow PostHog capture from localhost when using a real project key.",
  PDF_SIGNING_TSA_URL:
    "Single RFC 3161 timestamp authority for PDF signing, appended to PDF_SIGNING_TSA_URLS.",
  PDF_SIGNING_TSA_TRUST_PEM:
    "Trust anchors for PDF signing timestamps: PEM text or a path to a PEM file (CA certificates, or an authority's own certificate to pin it). Unset embeds timestamps without counting them as trusted time.",
  PDF_SIGNING_TSA_URLS:
    "RFC 3161 timestamp authorities for PDF signing in preference order, comma separated; the next one is tried when one fails. Unset signs at PAdES B-B.",
  PUBLIC_URL:
    "Public API origin for OAuth callbacks. Defaults to BETTER_AUTH_URL.",
  QUERY_EXPANSION_MODE:
    'Morphological expansion of case-law search terms: "off" builds today\'s query, "shadow" runs the unexpanded query and records leaf counts comparing it with the expanded one (never the query text). "on" runs the expanded query; a search cursor names the dictionary its page used, so a continuation built against another one is rejected as invalid.',
  REDIS_TLS_REJECT_UNAUTHORIZED:
    "Whether a rediss:// connection verifies the server certificate chain. " +
    "Leave on unless the endpoint presents a certificate no trust anchor can " +
    "validate and the private network is the boundary instead.",
  REDIS_URL:
    "Valkey or Redis URL used for cross-instance broadcasts and rate limits. Set maxmemory-policy noeviction on the server for durable coordination, including queues, locks, reservations, and fences. Treated as secret because it may contain credentials.",
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
  SESSION_TOKEN_ROTATION_ENABLED:
    "Rotate browser session credentials on refresh. Defaults off; enable after every API instance supports prior credentials.",
  MCP_WEB_HANDOFF_MINT_ENABLED:
    "Enable sign-in handoffs on connected-app links. Defaults off.",
  MCP_WEB_HANDOFF_TEXT_ENABLED:
    "Include sign-in handoff codes in MCP text links. Defaults off; opt in separately from link minting.",
  MCP_WEB_HANDOFF_TEXT_SESSION_MAX_SECONDS:
    "Absolute lifetime in seconds for sessions created from MCP text links; defaults to twelve hours and cannot exceed it.",
  SESSION_LIFETIME_CAP_ENABLED:
    "Apply the ninety-day session cap at startup after one idle hour. Defaults off; enable after activity tracking is established.",
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
  OPERATOR_API_TOKEN:
    "Deployment-owned bearer credential for operator HTTP access. Unset disables access; use at least 32 characters.",
  STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE:
    'Client-IP source for signup limits. Use "direct" without a proxy and "trusted_proxy" behind configured proxies.',
  STELLA_CLIENT_ADDRESS_HEADER:
    "Header the edge sets to the viewer address (e.g. cloudfront-viewer-address; see STELLA_CLIENT_ADDRESS_FORMAT). Read only from STELLA_TRUSTED_PROXY_CIDRS peers; set only when every route to the API adds it.",
  STELLA_CLIENT_ADDRESS_FORMAT:
    "How STELLA_CLIENT_ADDRESS_HEADER spells the address: with-port (default, e.g. cloudfront-viewer-address) or bare.",
  STELLA_ORIGIN_VERIFY_SECRET:
    "Current value the edge sends in x-stella-origin-verify. One value of at least 32 characters; the client address header accepts this or STELLA_ORIGIN_VERIFY_SECRET_PREVIOUS.",
  STELLA_ORIGIN_VERIFY_SECRET_PREVIOUS:
    "Optional previous origin value accepted during a rotation. One value of at least 32 characters, stored separately from STELLA_ORIGIN_VERIFY_SECRET.",
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
  TYPESAFE_API_KEY:
    "Instance decision model key (TypeSafe System One). An organization may set its own in AI settings; unset and without one, typed decisions fall back to the generative model.",
  TYPESAFE_MODEL:
    'System One model id sent to TypeSafe. Defaults to "jev-latest"; pin a versioned id to hold calibrated thresholds.',
  USE_MOCK_AI:
    'Return canned AI responses in local development and tests. An organization\'s own AI key still answers for real; "force" mocks those requests too. Deployed runtimes reject this setting.',
  VITE_API_URL: "API base URL used by the SPA for Eden treaty requests.",
  VITE_BROWSER_API_URL:
    "Same-origin browser API mount. Must be the exact /api path on VITE_PUBLIC_APP_URL; unset uses VITE_API_URL.",
  VITE_AUTH_GOOGLE:
    "Show Google login only when the API has matching OAuth credentials.",
  VITE_AUTH_MICROSOFT:
    "Show Microsoft login only when the API has matching OAuth credentials.",
  VITE_AUTH_APPLE:
    "Show Sign in with Apple only when the API has a matching Apple configuration.",
  VITE_COLLAB_URL:
    "WebSocket URL for collaborative editing. Unset keeps the single-user editing path.",
  VITE_BETA_FEATURES_ENABLED:
    "Expose Settings → Beta features without enabling any preview by default.",
  VITE_FEATURE_GOVERNED_WORKFLOW:
    "Show governed work-obligation fields on a task (owner, acknowledgement, hard deadline).",
  VITE_FEATURE_INBOX:
    "Show the Inbox and the notification bell for everyone, without the per-browser beta toggle.",
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
  CONTENT_ENCRYPTION_KEY: "the process runs without local development access",
  DB_LOAD_GATE_EBS_SIGNAL: "DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER is unset",
  DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER:
    "the database is RDS and DB_LOAD_GATE_EBS_SIGNAL is unset",
  CORPUS_INDEX_Q09_ENDPOINT:
    "LEGAL_SEARCH_PROVIDER is corpus-index and CORPUS_INDEX_Q09_SEARCH_ENDPOINT is unset",
  CORPUS_PROJECTION_OWNER: "CORPUS_STORAGE_MODE is canonical",
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL: "another EMAIL_EVENTS_* key is set",
  EMAIL_EVENTS_QUEUE_URL: "another EMAIL_EVENTS_* key is set",
  EMAIL_EVENTS_TOPIC_ARN: "another EMAIL_EVENTS_* key is set",
  INBOUND_MAIL_BUCKET: "another INBOUND_MAIL_* transport key is set",
  INBOUND_MAIL_DOMAIN: "an INBOUND_MAIL_* transport key is set",
  INBOUND_MAIL_KEY_PREFIX: "another INBOUND_MAIL_* transport key is set",
  INBOUND_MAIL_QUEUE_URL: "another INBOUND_MAIL_* transport key is set",
  INBOUND_MAIL_TOPIC_ARN: "another INBOUND_MAIL_* transport key is set",
  LEGAL_CORPUS_S3_BUCKET: "corpus storage is enabled in a deployed environment",
  MICROSOFT_AUTH_TENANT_ID: "Microsoft OAuth credentials are configured",
  APPLE_AUTH_CLIENT_ID: "another APPLE_AUTH_* key is set",
  APPLE_AUTH_KEY_ID: "another APPLE_AUTH_* key is set",
  APPLE_AUTH_PRIVATE_KEY: "another APPLE_AUTH_* key is set",
  APPLE_AUTH_TEAM_ID: "another APPLE_AUTH_* key is set",
  ORG_EVALUATION_PERIOD_DAYS: "FEATURE_ORG_ACCESS_STATE is true",
  REDIS_URL: "the API server or the document-processing worker runs",
  S3_ACCESS_KEY_ID: 'S3_CREDENTIALS_PROVIDER is "env"',
  S3_SECRET_ACCESS_KEY: 'S3_CREDENTIALS_PROVIDER is "env"',
  SES_REGION: "EMAIL_PROVIDER is ses",
  SMTP_HOST: "EMAIL_PROVIDER is smtp",
  SMTP_PORT: "EMAIL_PROVIDER is smtp",
  TRANSACTIONAL_EMAIL_FROM: "EMAIL_PROVIDER is ses or smtp",
};

export const ENV_CREDENTIAL_KIND = {
  credential: "credential",
  notCredential: "not-credential",
} as const;

type EnvCatalogName =
  | keyof typeof envBaseServerSchema
  | keyof typeof databaseComponentEnvSchema
  | keyof typeof envOnlineIndexServerSchema
  | keyof typeof envDocumentProcessingWorkerServerSchema
  | keyof typeof envApiServerSchema
  | keyof typeof envCollabServerSchema
  | keyof typeof replayTickServerSchema
  | keyof typeof euCompletionTickServerSchema
  | keyof typeof envWebClientSchema;

// Budget keys are one non-credential group derived from the schema. The total
// explicit map continues to classify every key outside that group.
export const ENV_CREDENTIAL_CLASSIFICATION = {
  ...Object.fromEntries(
    Object.keys(rateLimitBudgetEnvSchema).map(
      (name) => [name, ENV_CREDENTIAL_KIND.notCredential] as const,
    ),
  ),
  LIST_VERIFICATION_ACTIVE_RUNS_MAX: ENV_CREDENTIAL_KIND.notCredential,
  LIST_VERIFICATION_DAILY_STARTS_MAX: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_BACKGROUND_ORG_CONCURRENCY:
    ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_BACKGROUND_USER_CONCURRENCY:
    ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_LEASE_MS: ENV_CREDENTIAL_KIND.notCredential,
  MCP_PUBLIC_READ_CALLER_CONCURRENCY: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_ORG_CONCURRENCY: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_PERIOD_ACTIONS: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_PERIOD_MS: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_ADMISSION_USER_CONCURRENCY: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_COST_CALL_RATES: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_COST_ESTIMATES: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_COST_RETENTION_DAYS: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_LIMIT_CONTACT_URL: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_PAGE_SIZE_MAX: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_REQUEST_MAX_BYTES: ENV_CREDENTIAL_KIND.notCredential,
  ACTION_RESPONSE_MAX_BYTES: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_CLIENT_STORAGE_V1_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_REGISTRATION_DAILY_LIMIT: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_DOCKER_NETWORK: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_DOCKER_SOCKET: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_HARNESS_API_KEY: ENV_CREDENTIAL_KIND.credential,
  AGENT_SANDBOX_HARNESS_BASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_HARNESS_MODEL: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_IMAGE: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_MCP_URL: ENV_CREDENTIAL_KIND.notCredential,
  AGENT_SANDBOX_RUNS_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  AI_MODEL_CHAT: ENV_CREDENTIAL_KIND.notCredential,
  AI_MODEL_FAST: ENV_CREDENTIAL_KIND.notCredential,
  AI_MODEL_PDF: ENV_CREDENTIAL_KIND.notCredential,
  AI_MODEL_REASONING: ENV_CREDENTIAL_KIND.notCredential,
  AI_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
  AI_PROVIDER_BASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  ANTHROPIC_API_KEY: ENV_CREDENTIAL_KIND.credential,
  APP_REVIEW_ACCOUNT_EMAIL: ENV_CREDENTIAL_KIND.notCredential,
  APP_REVIEW_ORGANIZATION_ID: ENV_CREDENTIAL_KIND.notCredential,
  AZURE_API_KEY: ENV_CREDENTIAL_KIND.credential,
  AZURE_API_VERSION: ENV_CREDENTIAL_KIND.notCredential,
  AZURE_BASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  AZURE_RESOURCE_NAME: ENV_CREDENTIAL_KIND.notCredential,
  BEDROCK_API_KEY: ENV_CREDENTIAL_KIND.credential,
  BETTER_AUTH_COOKIE_PREFIX: ENV_CREDENTIAL_KIND.notCredential,
  DEPLOY_ENVIRONMENT: ENV_CREDENTIAL_KIND.notCredential,
  BETTER_AUTH_SECRET: ENV_CREDENTIAL_KIND.credential,
  BETTER_AUTH_URL: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_DATABASE_POOL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_DERIVED_AI: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_REPLAY_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_REPLAY_KILL_SWITCH: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_REPLAY_DISABLED_SOURCES: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_EU_COMPLETION_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_EU_COMPLETION_KILL_SWITCH: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_EU_COMPLETION_MAX_ROWS: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_EU_COMPLETION_MODE: ENV_CREDENTIAL_KIND.notCredential,
  CASE_LAW_DATABASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  COMPANIES_HOUSE_API_KEY: ENV_CREDENTIAL_KIND.credential,
  CONTENT_ENCRYPTION_KEY: ENV_CREDENTIAL_KIND.credential,
  CORPUS_INDEX_Q09_ENDPOINT: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_INDEX_Q09_SEARCH_ENDPOINT: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_INDEX_QUERY_VARIANT: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_INDEX_RANKING_MODE: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_INDEX_S3_BUCKET: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_MEMBER_LAYOUT: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_PROJECTION_OWNER: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_STORAGE_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  CORPUS_STORAGE_MODE: ENV_CREDENTIAL_KIND.notCredential,
  DATABASE_POOL_IDLE_TIMEOUT_S: ENV_CREDENTIAL_KIND.notCredential,
  DATABASE_POOL_MAX_LIFETIME_S: ENV_CREDENTIAL_KIND.notCredential,
  DATABASE_RLS_POOL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  DATABASE_ROOT_POOL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  DATABASE_STATEMENT_TIMEOUT_MS: ENV_CREDENTIAL_KIND.notCredential,
  DATA_INVARIANT_CASE_LAW_CANARIES: ENV_CREDENTIAL_KIND.notCredential,
  DATA_INVARIANT_CASE_LAW_DAILY_BANDS: ENV_CREDENTIAL_KIND.notCredential,
  DATABASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  DB_HOST: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_BUSY_WINDOWS: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_EBS_SIGNAL: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_HARD_FLOOR: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_LONG_TX_MAX_AGE_MS: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_MAX_HELD_MS: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_MAX_STALENESS_MS: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_READ_TIMEOUT_MS: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER: ENV_CREDENTIAL_KIND.notCredential,
  DB_LOAD_GATE_START_FLOOR: ENV_CREDENTIAL_KIND.notCredential,
  DB_NAME: ENV_CREDENTIAL_KIND.notCredential,
  DB_PASSWORD: ENV_CREDENTIAL_KIND.credential,
  DB_PORT: ENV_CREDENTIAL_KIND.notCredential,
  DB_SSLMODE: ENV_CREDENTIAL_KIND.notCredential,
  DB_USER: ENV_CREDENTIAL_KIND.notCredential,
  DEBUG_UNREDACTED_ERRORS: ENV_CREDENTIAL_KIND.notCredential,
  DEMO_ACCOUNT_EMAIL: ENV_CREDENTIAL_KIND.notCredential,
  DEMO_ACCOUNT_ORGANIZATION_ID: ENV_CREDENTIAL_KIND.notCredential,
  DEMO_ACCOUNT_OTP: ENV_CREDENTIAL_KIND.credential,
  DEV_PUBLIC_LAW_CONNECT_COMMAND: ENV_CREDENTIAL_KIND.notCredential,
  DOCUMENT_OCR_BATCH_INTERVAL_MINUTES: ENV_CREDENTIAL_KIND.notCredential,
  DOCUMENT_OCR_MODEL_DIR: ENV_CREDENTIAL_KIND.notCredential,
  DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES: ENV_CREDENTIAL_KIND.notCredential,
  E2E_DISABLE_AUTH_RATE_LIMIT: ENV_CREDENTIAL_KIND.notCredential,
  SCHEDULED_JOBS_MODE: ENV_CREDENTIAL_KIND.notCredential,
  EDGAR_USER_AGENT: ENV_CREDENTIAL_KIND.notCredential,
  EMAIL_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
  EXTENSION_ORIGIN: ENV_CREDENTIAL_KIND.notCredential,
  API_FEATURE_ACCESS_GRANTS: ENV_CREDENTIAL_KIND.notCredential,
  KILL_SWITCHES: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_ACTION_ADMISSION: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_ACTION_COST_RECORDS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_AGENT_ID_JAG: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_AI_MEMORY: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_CONFIGURED_ACCESS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_FILE_USAGE_LIMITS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_FREE_TIER: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_GOVERNED_WORKFLOW: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_GENERATED_VIEWS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_INBOX_DOCUMENT_SCOUTS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_LEGAL_LISTS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_MANAGED_PROVIDER_CHECKS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_MCP_READ_FENCE: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_ORG_ACCESS_STATE: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_ORG_SERVICE_BUDGETS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_PUBLIC_KNOWLEDGE: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_PUBLIC_LAW: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_PUBLIC_TOOLS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_SHAREPOINT: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_TEMPLATE_PACKS: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_TIME_BILLING: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_USAGE: ENV_CREDENTIAL_KIND.notCredential,
  FEATURE_WEB_SEARCH: ENV_CREDENTIAL_KIND.notCredential,
  FEEDBACK_EMAIL_TO: ENV_CREDENTIAL_KIND.notCredential,
  FEEDBACK_GITHUB_REPO: ENV_CREDENTIAL_KIND.notCredential,
  FEEDBACK_GITHUB_TOKEN: ENV_CREDENTIAL_KIND.credential,
  FRONTEND_URL: ENV_CREDENTIAL_KIND.notCredential,
  GITHUB_TOKEN: ENV_CREDENTIAL_KIND.credential,
  GOOGLE_AI_API_KEY_CH: ENV_CREDENTIAL_KIND.credential,
  GOOGLE_AI_API_KEY_EU: ENV_CREDENTIAL_KIND.credential,
  APPLE_AUTH_CLIENT_ID: ENV_CREDENTIAL_KIND.notCredential,
  APPLE_AUTH_KEY_ID: ENV_CREDENTIAL_KIND.notCredential,
  APPLE_AUTH_PRIVATE_KEY: ENV_CREDENTIAL_KIND.credential,
  APPLE_AUTH_TEAM_ID: ENV_CREDENTIAL_KIND.notCredential,
  GOOGLE_AUTH_CLIENT_ID: ENV_CREDENTIAL_KIND.notCredential,
  GOOGLE_AUTH_CLIENT_SECRET: ENV_CREDENTIAL_KIND.credential,
  GOOGLE_GENERATIVE_AI_API_KEY: ENV_CREDENTIAL_KIND.credential,
  GOTENBERG_PASSWORD: ENV_CREDENTIAL_KIND.credential,
  GOTENBERG_URL: ENV_CREDENTIAL_KIND.notCredential,
  GOTENBERG_USERNAME: ENV_CREDENTIAL_KIND.notCredential,
  HOSTED_USAGE_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
  HOSTED_USAGE_PROVIDER_API_KEY: ENV_CREDENTIAL_KIND.credential,
  HOSTED_USAGE_PROVIDER_API_VERSION: ENV_CREDENTIAL_KIND.notCredential,
  HOSTED_USAGE_PROVIDER_BASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  HOSTED_USAGE_WEBHOOK_RETENTION_DAYS: ENV_CREDENTIAL_KIND.notCredential,
  HOSTED_USAGE_WEBHOOK_SECRET: ENV_CREDENTIAL_KIND.credential,
  HOSTED_USAGE_WEBHOOK_SECRET_PREVIOUS: ENV_CREDENTIAL_KIND.credential,
  HUGGINGFACE_API_KEY: ENV_CREDENTIAL_KIND.credential,
  HUGGINGFACE_BASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  EMAIL_EVENTS_DEAD_LETTER_QUEUE_URL: ENV_CREDENTIAL_KIND.notCredential,
  EMAIL_EVENTS_QUEUE_URL: ENV_CREDENTIAL_KIND.notCredential,
  EMAIL_EVENTS_TOPIC_ARN: ENV_CREDENTIAL_KIND.notCredential,
  INBOUND_MAIL_BUCKET: ENV_CREDENTIAL_KIND.notCredential,
  INBOUND_MAIL_DOMAIN: ENV_CREDENTIAL_KIND.notCredential,
  INBOUND_MAIL_KEY_PREFIX: ENV_CREDENTIAL_KIND.notCredential,
  INBOUND_MAIL_QUEUE_URL: ENV_CREDENTIAL_KIND.notCredential,
  INBOUND_MAIL_TOPIC_ARN: ENV_CREDENTIAL_KIND.notCredential,
  INEGI_DENUE_API_TOKEN: ENV_CREDENTIAL_KIND.credential,
  INGESTION_USER_AGENT: ENV_CREDENTIAL_KIND.notCredential,
  JINA_API_KEY: ENV_CREDENTIAL_KIND.credential,
  LEGAL_CORPUS_S3_BUCKET: ENV_CREDENTIAL_KIND.notCredential,
  LEGAL_SEARCH_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
  LOGS_OTLP_TOKEN: ENV_CREDENTIAL_KIND.credential,
  LOGS_OTLP_URL: ENV_CREDENTIAL_KIND.notCredential,
  MANAGED_PROVIDER_CHECK_INTERVAL_MS: ENV_CREDENTIAL_KIND.notCredential,
  MANAGED_PROVIDER_CHECK_TIMEOUT_MS: ENV_CREDENTIAL_KIND.notCredential,
  MCP_CASE_LAW_SEARCH_GUIDANCE: ENV_CREDENTIAL_KIND.notCredential,
  MCP_READ_PUBLIC_ORG_BYTES: ENV_CREDENTIAL_KIND.notCredential,
  MCP_READ_PUBLIC_USER_BYTES: ENV_CREDENTIAL_KIND.notCredential,
  MCP_READ_TENANT_ORG_BYTES: ENV_CREDENTIAL_KIND.notCredential,
  MCP_READ_TENANT_USER_BYTES: ENV_CREDENTIAL_KIND.notCredential,
  MCP_READ_WINDOW_MAX_ENTRIES: ENV_CREDENTIAL_KIND.notCredential,
  MCP_READ_WINDOW_MS: ENV_CREDENTIAL_KIND.notCredential,
  MICROSOFT_AUTH_CLIENT_ID: ENV_CREDENTIAL_KIND.notCredential,
  MICROSOFT_AUTH_CLIENT_SECRET: ENV_CREDENTIAL_KIND.credential,
  MICROSOFT_AUTH_TENANT_ID: ENV_CREDENTIAL_KIND.notCredential,
  MICROSOFT_REQUIRE_VERIFIED_EMAIL_CLAIM: ENV_CREDENTIAL_KIND.notCredential,
  MISTRAL_API_KEY: ENV_CREDENTIAL_KIND.credential,
  ONLINE_INDEX_CLIENT_CHECK_MS: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_IDLE_HOLDER_MS: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_LONG_HOLDER_MS: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_MAINTENANCE_WORK_MEM_MB: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_MAX_SNAPSHOT_WAIT_MS: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_PARALLEL_WORKERS: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_POLL_MS: ENV_CREDENTIAL_KIND.notCredential,
  ONLINE_INDEX_RETRY_MS: ENV_CREDENTIAL_KIND.notCredential,
  OPENAI_API_KEY: ENV_CREDENTIAL_KIND.credential,
  OPENAI_APPS_CHALLENGE_TOKEN: ENV_CREDENTIAL_KIND.credential,
  OPENROUTER_API_KEY: ENV_CREDENTIAL_KIND.credential,
  OPENROUTER_FAST_TIER_API_KEY: ENV_CREDENTIAL_KIND.credential,
  OPENROUTER_FAST_TIER_WIF_POLICY_ID: ENV_CREDENTIAL_KIND.notCredential,
  OPENROUTER_WIF_AUDIENCE: ENV_CREDENTIAL_KIND.notCredential,
  OPENROUTER_WIF_POLICY_ID: ENV_CREDENTIAL_KIND.notCredential,
  OPENROUTER_WIF_STS_REGION: ENV_CREDENTIAL_KIND.notCredential,
  OPEN_CLIENT_REGISTRATION_DAILY_LIMIT: ENV_CREDENTIAL_KIND.notCredential,
  ORG_EVALUATION_PERIOD_DAYS: ENV_CREDENTIAL_KIND.notCredential,
  PAYMENT_RETRY_WINDOW_MS: ENV_CREDENTIAL_KIND.notCredential,
  PDF_SIGNING_TSA_TRUST_PEM: ENV_CREDENTIAL_KIND.notCredential,
  PDF_SIGNING_TSA_URL: ENV_CREDENTIAL_KIND.notCredential,
  PDF_SIGNING_TSA_URLS: ENV_CREDENTIAL_KIND.notCredential,
  PORT: ENV_CREDENTIAL_KIND.notCredential,
  POSTHOG_HOST: ENV_CREDENTIAL_KIND.notCredential,
  POSTHOG_KEY: ENV_CREDENTIAL_KIND.notCredential,
  POSTHOG_LOCAL_DEBUG: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_AGGREGATE_GLOBAL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_AGGREGATE_P95_SECONDS: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_ASSUMED_REPLICAS: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_RESERVED_CONNECTIONS: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_SEARCH_ADDRESS_MAX: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_SEARCH_GLOBAL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_SEARCH_P95_SECONDS: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_SITEMAP_GLOBAL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_CORPUS_SITEMAP_P95_SECONDS: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_LAW_DATABASE_POOL_MAX: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_LAW_DATABASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  PUBLIC_URL: ENV_CREDENTIAL_KIND.notCredential,
  QUERY_EXPANSION_MODE: ENV_CREDENTIAL_KIND.notCredential,
  REDIS_CONNECTION_ENFORCED: ENV_CREDENTIAL_KIND.notCredential,
  REDIS_PASSWORD: ENV_CREDENTIAL_KIND.credential,
  REDIS_TLS_CA_PEM: ENV_CREDENTIAL_KIND.notCredential,
  REDIS_TLS_REJECT_UNAUTHORIZED: ENV_CREDENTIAL_KIND.notCredential,
  REDIS_TLS_SERVER_NAME: ENV_CREDENTIAL_KIND.notCredential,
  REDIS_URL: ENV_CREDENTIAL_KIND.notCredential,
  REDIS_USERNAME: ENV_CREDENTIAL_KIND.notCredential,
  REPORT_SPECS_DIR: ENV_CREDENTIAL_KIND.notCredential,
  REPORT_SPECS_S3_PREFIX: ENV_CREDENTIAL_KIND.notCredential,
  REQUIRE_PERSONAL_AI_KEY: ENV_CREDENTIAL_KIND.notCredential,
  S3_ACCESS_KEY_ID: ENV_CREDENTIAL_KIND.notCredential,
  S3_BUCKET: ENV_CREDENTIAL_KIND.notCredential,
  S3_CREDENTIALS_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
  S3_ENDPOINT: ENV_CREDENTIAL_KIND.notCredential,
  S3_REGION: ENV_CREDENTIAL_KIND.notCredential,
  S3_SCOPED_SIGNING_ROLE_ARN: ENV_CREDENTIAL_KIND.notCredential,
  S3_SECRET_ACCESS_KEY: ENV_CREDENTIAL_KIND.credential,
  SANCTIONS_EU_XML_URL: ENV_CREDENTIAL_KIND.notCredential,
  SECURITY_CANARY_API_KEY_SHA256: ENV_CREDENTIAL_KIND.notCredential,
  SELFHOST_BOOTSTRAP_TOKEN: ENV_CREDENTIAL_KIND.credential,
  SELFHOST_LOCAL_PASSWORD_AUTH: ENV_CREDENTIAL_KIND.notCredential,
  SERVICE_ACTIONS_EVALUATION_PERIOD_ACTIONS: ENV_CREDENTIAL_KIND.notCredential,
  SERVICE_ACTIONS_SELF_MANAGED_ACTIONS: ENV_CREDENTIAL_KIND.notCredential,
  SESSION_LIFETIME_CAP_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  MCP_WEB_HANDOFF_MINT_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  MCP_WEB_HANDOFF_TEXT_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  MCP_WEB_HANDOFF_TEXT_SESSION_MAX_SECONDS: ENV_CREDENTIAL_KIND.notCredential,
  SESSION_TOKEN_ROTATION_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  SES_ACCESS_KEY_ID: ENV_CREDENTIAL_KIND.notCredential,
  SES_CONFIGURATION_SET: ENV_CREDENTIAL_KIND.notCredential,
  SES_REGION: ENV_CREDENTIAL_KIND.notCredential,
  SES_SECRET_ACCESS_KEY: ENV_CREDENTIAL_KIND.credential,
  STELLA_ALLOW_PRIVILEGED_DB_LOGIN_FOR_LOCAL_DEV:
    ENV_CREDENTIAL_KIND.notCredential,
  SKIP_MIGRATION_CHECK: ENV_CREDENTIAL_KIND.notCredential,
  SMOKE_SESSION_SECRET: ENV_CREDENTIAL_KIND.credential,
  SYNTHETIC_SESSION_KEYS: ENV_CREDENTIAL_KIND.credential,
  SMTP_HOST: ENV_CREDENTIAL_KIND.notCredential,
  SMTP_PASSWORD: ENV_CREDENTIAL_KIND.credential,
  SMTP_PORT: ENV_CREDENTIAL_KIND.notCredential,
  SMTP_USERNAME: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_API_PORT: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_API_URL: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_CLIENT_ADDRESS_FORMAT: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_CLIENT_ADDRESS_HEADER: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_COLLAB_MODE: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_COLLAB_PORT: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_COLLAB_REDIS_URL: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_COLLAB_SERVICE_TOKEN: ENV_CREDENTIAL_KIND.credential,
  OPERATOR_API_TOKEN: ENV_CREDENTIAL_KIND.credential,
  STELLA_COMMIT_SHA: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_OCR_PDF_FONT_PATH: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_ORIGIN_VERIFY_SECRET: ENV_CREDENTIAL_KIND.credential,
  STELLA_ORIGIN_VERIFY_SECRET_PREVIOUS: ENV_CREDENTIAL_KIND.credential,
  STELLA_SIGNUP_RATE_LIMIT_IP_SOURCE: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_TRUSTED_PROXY_CIDRS: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_USAGE_POLICY_SEEDS: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_VERSION: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_WORKER_DIR: ENV_CREDENTIAL_KIND.notCredential,
  STELLA_YARA_RULES_DIR: ENV_CREDENTIAL_KIND.notCredential,
  TAVILY_API_KEY: ENV_CREDENTIAL_KIND.credential,
  TEMPLATE_PACKS_CONTENT_DIR: ENV_CREDENTIAL_KIND.notCredential,
  TRANSACTIONAL_EMAIL_FROM: ENV_CREDENTIAL_KIND.notCredential,
  TYPESAFE_API_KEY: ENV_CREDENTIAL_KIND.credential,
  TYPESAFE_MODEL: ENV_CREDENTIAL_KIND.notCredential,
  UNUSED_CLIENT_RETENTION_DAYS: ENV_CREDENTIAL_KIND.notCredential,
  USAGE_ENFORCEMENT_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  USE_MOCK_AI: ENV_CREDENTIAL_KIND.notCredential,
  VISUAL_PREVIEW_FUNCTION_NAME: ENV_CREDENTIAL_KIND.notCredential,
  VITE_API_URL: ENV_CREDENTIAL_KIND.notCredential,
  VITE_AUTH_GOOGLE: ENV_CREDENTIAL_KIND.notCredential,
  VITE_AUTH_MICROSOFT: ENV_CREDENTIAL_KIND.notCredential,
  VITE_AUTH_APPLE: ENV_CREDENTIAL_KIND.notCredential,
  VITE_BETA_FEATURES_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_BROWSER_API_URL: ENV_CREDENTIAL_KIND.notCredential,
  VITE_COLLAB_URL: ENV_CREDENTIAL_KIND.notCredential,
  VITE_DESKTOP_BRIDGE_PORT: ENV_CREDENTIAL_KIND.notCredential,
  VITE_DESKTOP_RELEASES_BASE_URL: ENV_CREDENTIAL_KIND.notCredential,
  VITE_FEATURE_FOLIO_COLLAB: ENV_CREDENTIAL_KIND.notCredential,
  VITE_FEATURE_GOVERNED_WORKFLOW: ENV_CREDENTIAL_KIND.notCredential,
  VITE_FEATURE_INBOX: ENV_CREDENTIAL_KIND.notCredential,
  VITE_FEATURE_USAGE: ENV_CREDENTIAL_KIND.notCredential,
  VITE_POSTHOG_HOST: ENV_CREDENTIAL_KIND.notCredential,
  VITE_POSTHOG_KEY: ENV_CREDENTIAL_KIND.notCredential,
  VITE_POSTHOG_LOCAL_DEBUG: ENV_CREDENTIAL_KIND.notCredential,
  VITE_POSTHOG_UI_HOST: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_APP_URL: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_KNOWLEDGE_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_KNOWLEDGE_INDEXING_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_LAW_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_LAW_INDEXING_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_TOOLS_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_PUBLIC_TOOLS_INDEXING_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  VITE_SELFHOST: ENV_CREDENTIAL_KIND.notCredential,
  VITE_SEO_INDEXABLE: ENV_CREDENTIAL_KIND.notCredential,
  VITE_TERMS_URL: ENV_CREDENTIAL_KIND.notCredential,
  VITE_WORKFLOWS_ENABLED: ENV_CREDENTIAL_KIND.notCredential,
  WEB_FETCH_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
  WEB_SEARCH_PROVIDER: ENV_CREDENTIAL_KIND.notCredential,
} as const satisfies Record<
  Exclude<EnvCatalogName, keyof typeof rateLimitBudgetEnvSchema>,
  (typeof ENV_CREDENTIAL_KIND)[keyof typeof ENV_CREDENTIAL_KIND]
>;

const credentialClassifications = new Map(
  Object.entries(ENV_CREDENTIAL_CLASSIFICATION),
);

const ACTIVE_EXAMPLE_KEYS = new Set([
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "DATABASE_ROOT_POOL_MAX",
  "DATABASE_RLS_POOL_MAX",
  "DATABASE_URL",
  "DB_LOAD_GATE_BUSY_WINDOWS",
  "DB_LOAD_GATE_EBS_SIGNAL",
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
  "OPERATOR_API_TOKEN",
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
  if (Object.hasOwn(rateLimitBudgetEnvSchema, name)) {
    return "Request budgets";
  }
  if (
    /^(DATABASE|DB_|ONLINE_INDEX_|STELLA_WORKER|SKIP_MIGRATION)/u.test(name)
  ) {
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
    /^(BETTER_AUTH|GOOGLE_AUTH|MICROSOFT_AUTH|APPLE_AUTH|SELFHOST|SECURITY_CANARY|SESSION_)/u.test(
      name,
    )
  ) {
    return "Authentication";
  }
  if (/^(EMAIL|INBOUND_MAIL|SES_|SMTP_|TRANSACTIONAL|FEEDBACK)/u.test(name)) {
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

// Every value a picklist accepts is spelled out in source, so it can never
// hold a secret.
const isPicklistSchema = (schema: v.GenericSchema): boolean => {
  const inner =
    schema.type === "optional" && "wrapped" in schema ? schema.wrapped : schema;
  return (
    typeof inner === "object" &&
    inner !== null &&
    "type" in inner &&
    inner.type === "picklist"
  );
};

type ExposureForOptions = {
  name: string;
  owner: EnvOwner;
  schema: v.GenericSchema;
};

const exposureFor = ({
  name,
  owner,
  schema,
}: ExposureForOptions): EnvExposure => {
  if (owner === ENV_OWNER.web || name === "ACTION_LIMIT_CONTACT_URL") {
    return ENV_EXPOSURE.public;
  }
  if (isPicklistSchema(schema) || INTERNAL_SERVER_KEYS.has(name)) {
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
    const credentialKind = credentialClassifications.get(name);
    if (credentialKind === undefined) {
      panic(
        `Environment variable ${name} must declare a credential classification.`,
      );
    }
    const requirementNote = CONDITIONAL_REQUIREMENT_NOTES[name];
    return {
      credentialKind,
      description: DESCRIPTION_OVERRIDES[name] ?? humanizeEnvName(name),
      documented: !HIDDEN_SCHEMA_KEYS.has(name),
      example: EXAMPLE_VALUES[name],
      exposure: exposureFor({ name, owner, schema: entrySchema }),
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
    schema: euCompletionTickServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiBase,
    schema: replayTickServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiBase,
    schema: envBaseServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiBase,
    schema: databaseComponentEnvSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiBase,
    schema: envOnlineIndexServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.documentWorker,
    schema: envDocumentProcessingWorkerServerSchema,
  }),
  ...createCatalogEntries({
    owner: ENV_OWNER.apiServer,
    schema: Object.fromEntries(
      Object.entries(envApiServerSchema).filter(
        ([name]) => !Object.hasOwn(envBaseServerSchema, name),
      ),
    ),
  }),
  ...createCatalogEntries({ owner: ENV_OWNER.web, schema: envWebClientSchema }),
  ...createCatalogEntries({
    owner: ENV_OWNER.collab,
    schema: envCollabServerSchema,
  }),
];

export const API_ENV_SCHEMA = {
  ...euCompletionTickServerSchema,
  ...replayTickServerSchema,
  ...envBaseServerSchema,
  ...envOnlineIndexServerSchema,
  ...envDocumentProcessingWorkerServerSchema,
  ...envApiServerSchema,
};

export type ApiEnvironmentName = keyof typeof API_ENV_SCHEMA;

export const WEB_ENV_SCHEMA = envWebClientSchema;
export const COLLAB_ENV_SCHEMA = envCollabServerSchema;

export type WebEnvironmentName = keyof typeof WEB_ENV_SCHEMA;

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
  "DB_STATEMENT_TIMEOUT_MS",
  "DB_TRANSACTION_TIMEOUT_MS",
  "DISABLED_ADAPTERS",
  // Expo inlines it into the mobile bundle; apps/mobile/src/env.ts reads it.
  "EXPO_PUBLIC_STELLA_SERVER_URL",
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
  "STELLA_DESKTOP_REGISTRY_WEB_ORIGIN",
  "STELLA_DESKTOP_TELEMETRY_LOCAL_DEBUG",
  "STELLA_DESKTOP_VIEW_PORT",
  "STELLA_ENABLE_DEBUG_CLIPBOARD_PERSISTENCE",
  "STELLA_GENERATED_STORE",
  "STELLA_OPEN_CLIPBOARD_ON_LAUNCH",
  "STELLA_PGLITE_SNAPSHOT_CACHE_DIR",
  "STELLA_SEED_EMAIL_WORKSPACE_ID",
  "STELLA_SERVER_URL",
  "STELLA_WEB_PORT",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "SSR",
]);

export const DEPLOYMENT_ENV_KEYS = new Set([
  "BUILDPLATFORM",
  "GOTENBERG_API_BASIC_AUTH_PASSWORD",
  "GOTENBERG_API_BASIC_AUTH_USERNAME",
  "POSTHOG_SOURCEMAP_PROJECT_ID",
  "POSTHOG_SOURCEMAP_PUBLISH",
  "PUBLIC_API_URL",
  "PUBLIC_APPLE_LOGIN_ENABLED",
  "PUBLIC_APP_URL",
  "PUBLIC_BROWSER_API_URL",
  "PUBLIC_GOOGLE_LOGIN_ENABLED",
  "PUBLIC_KNOWLEDGE_ENABLED",
  "PUBLIC_KNOWLEDGE_INDEXING_ENABLED",
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
  "STELLA_FILE_DERIVATIVE_WORKER_CPUS",
  "STELLA_FILE_DERIVATIVE_WORKER_MEM_LIMIT",
  "STELLA_FILE_DERIVATIVE_WORKER_PIDS_LIMIT",
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
]);

export const TOOLING_ENV_KEYS = new Set([
  // Release-only secret: the short-lived federated Chrome Web Store access token.
  "CHROME_WEB_STORE_ACCESS_TOKEN",
  // The mobile app's Expo config reads its variant and signing from the build.
  "APP_VARIANT",
  "APPLE_TEAM_ID",
  "MOBILE_BUILD_NUMBER",
  "MOBILE_PROFILE_UUID",
  "MOBILE_RUNTIME_VERSION",
  // Invocation-local handoff values are removed before test/native entry points run.
  "STELLA_TEST_PROCESS_STARTUP_GATE",
  "STELLA_TEST_NATIVE_COMMAND",
  // Windows dry-run receipts bind the build profile and executed workflow revision.
  "WINDOWS_BUILD_PROFILE",
  "WINDOWS_WORKFLOW_SHA",
  // Ordered frozen install flags shared by the scoped CI cache and installer.
  "STELLA_CI_INSTALL_FLAGS",
  // Installer budgets warn; verified restore outcome and key identify timing.
  "STELLA_CI_INSTALL_BUDGET_MS",
  "STELLA_CI_INSTALL_RESTORE",
  "STELLA_CI_INSTALL_KEY",
  // Scoped install-store ownership and phase measurement.
  "BUN_INSTALL_GLOBAL_STORE",
  "CACHE_HIT",
  "CACHE_WRITE",
  // Native cache action state is restored only for its own post hook.
  "STATE_key",
  "STATE_store",
  "STORE_KEY",
  "START_MS",
  "INSTALL_LOG",
  "RESTORE_MS",
  "INSTALL_MS",
  "INSTALL_OUTCOME",
  // Manual regeneration binds the requested PR and checks available job services.
  "PR_NUMBER",
  "JOB_SERVICES",
  // Workflow lint resolves the checksum-verified actionlint executable.
  "ACTIONLINT_BIN",
  // CI verification steps set it; workspace hygiene then requires prepared
  // API typecheck configs instead of skipping their install-time absence.
  "STELLA_VERIFY",
  "QUERY_PERF_CHANGED_PATHS",
  "QUERY_PERF_SCOPE_UNKNOWN",
  // CI image resolution and smoke tooling; product defaults remain upstream.
  "CI_IMAGE_MIRROR_ENABLED",
  "CI_PLAYWRIGHT_IMAGE",
  "POSTGRES_IMAGE",
  "REDIS_IMAGE",
  // The merge group's base revision.
  "MERGE_GROUP_BASE_SHA",
  // The scan engine drift check builds into a scratch directory and compares it.
  "SCAN_ENGINE_WASM_OUT_DIR",
  // The manual checks workflow passes its inputs and result files to its scripts.
  "CHECK_CHECK",
  "CHECK_EXIT_FILE",
  "CHECK_LOG_FILE",
  "CHECK_REF",
  "CHECK_SHA",
  "CHECK_START_FILE",
  "CHECK_TARGET",
  // Hosted agent runtimes identify themselves before secret-scanner bootstrap.
  "CLAUDE_CODE_REMOTE",
  "CODEX_CI",
  // Local verification host configuration, remote recursion guard, and base preparation.
  "STELLA_VERIFY_CONFIG",
  "REMOTE_CHECK",
  "CHECK_BASE_REF",
  "STELLA_VERIFY_LOCAL",
  // Manual document-fetch input is scoped to its workflow invocation.
  "PUBLIC_DOCUMENT_URLS",
  // Session ownership is passed from agent:up to its detached dev runner.
  "STELLA_DEV_SESSION_ID",
  // ci-result evaluates each independently scoped suite in folded jobs.
  "FOLDED_SUITES",
  // CI steps export the GitHub API retry helper's path after installing it.
  "GH_RETRY_SCRIPT",
  // The release resolve job exports the network retry helper's path, staged
  // from the workflow's own revision, for its git fetches.
  "NETWORK_RETRY_SCRIPT",
  // A release-candidate staging deploy starts staging (scripts/staging-wake.sh):
  // the commit it deploys, the infrastructure repository and its App token,
  // the readiness endpoint and edge header, and the bounds tests shorten.
  "DEPLOY_SHA",
  "INFRA_REPO",
  "STAGING_POWER_TOKEN",
  "STAGING_HEALTH_URL",
  "EDGE_HEADER_NAME",
  "EDGE_HEADER_VALUE",
  "STAGING_WAKE_LOOKUP_ATTEMPTS",
  "STAGING_WAKE_LOOKUP_INTERVAL_SECONDS",
  "STAGING_WAKE_START_MINUTES",
  "STAGING_WAKE_START_POLL_SECONDS",
  "STAGING_WAKE_READY_MINUTES",
  "STAGING_WAKE_READY_POLL_SECONDS",
  // The same script requests a candidate's power lease without waiting for
  // readiness, for the hours the promotion asks.
  "STAGING_LEASE_ONLY",
  "STAGING_LEASE_HOURS",
  // A staging promotion waits for the other owner kind (scripts/staging-owner.sh).
  "STAGING_OWNER_MODE",
  "STAGING_OWNER_ATTEMPTS",
  "STAGING_OWNER_INTERVAL_SECONDS",
  // Dated-waiver healing: the private repository its fix tasks go to.
  "DATED_WAIVER_FIX_REPO",
  // Preserve Bun global-store links inside browser containers.
  "BUN_INSTALL_CACHE_DIR",
  // Browser commands use only executables baked into the pinned image.
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_JSON_OUTPUT_FILE",
  "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
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
  "API_DEPLOYMENT_EXPECTED_ENVIRONMENT",
  "API_DEPLOYMENT_PROBE_PATH",
  "API_DEPLOYMENT_STABLE_PROBES",
  "API_DEPLOYMENT_URL",
  "API_SCOPE_UNKNOWN",
  "API_TEST_ARTIFACT_DIR",
  "API_TEST_CHILD_TIMEOUT_MS",
  // Resolved weight identity changes the Turbo test cache key.
  "API_TEST_DURATIONS_HASH",
  // Optional main-measured weights path; content identity is keyed separately.
  "API_TEST_DURATIONS_FILE",
  "API_TEST_FILES",
  "API_TEST_RUNNER_DEADLINE_MS",
  "API_TEST_SHARD_COUNT",
  "API_TEST_TIMINGS_DIR",
  "APP_VERSION",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "BASE_REF",
  "COMPARISON_BASE",
  "BASE_SHA",
  "CANARY_PORT",
  "CANARY_PROBE_TOKEN",
  "CANARY_SERVER_URL",
  "CANARY_SIGNING_SECRET",
  "CANARY_STATE_PATH",
  // Desktop release stamping receives these values from its workflow steps.
  "CHANNEL",
  "CHAT_SAVED_STATE_WRITE",
  "CHAT_TRANSCRIPTS_WRITE",
  // File holding ci-plan's changed paths for the changed-test repeat in ci-tests.
  "CHANGED_FILES_PATH",
  // Exact-base CI rehearsal: loopback URL for the separate disposable clean cluster.
  "CLEAN_DATABASE_URL",
  "CODEX_API_KEY",
  "DEV_API_PROXY_TARGET",
  "DEV_LINKED_PACKAGE_ROOTS",
  // Nightly issue reporter: suppress writes while exercising failure reporting.
  "DRY_RUN",
  "E2E_API_URL",
  "E2E_EDGE_HEADER_NAME",
  "E2E_EDGE_HEADER_VALUE",
  "E2E_EXECUTION_PROFILE",
  "E2E_EXPECT_DEV_ROUTES",
  "E2E_LANDING_URL",
  "E2E_NETWORK_BASELINE",
  "E2E_OUTPUT_DIR",
  "E2E_SOAK_REPLAY",
  "E2E_SOAK_SEED",
  "E2E_SOAK_STEPS",
  "E2E_WEB_URL",
  "EVENT_NAME",
  "EXPECTED_COMMIT",
  // Flake trial ownership and isolated subprocess fixture handoffs.
  "FLAKE_CHILD_RECORD",
  "FLAKE_GATE_FIXTURE_PRELOADED",
  "FLAKE_GATE_TRIAL",
  // Quarantine preload: report directory for its JSON lines; registry path override for fixture trees.
  "FLAKY_TEST_QUARANTINE_REGISTRY",
  "FLAKY_TEST_QUARANTINE_REPORT_DIR",
  "GH_READ_TOKEN",
  "HEAD_SHA",
  "HEAVY_ONLY",
  // Scheduled journey checks: endpoint overrides and bounded request/retry timing.
  "JOURNEY_CLI_URL",
  "JOURNEY_MAIN_REF",
  "JOURNEY_MCP_URL",
  "JOURNEY_NPM_REGISTRY_URL",
  "JOURNEY_REGISTRY_TIMEOUT_MS",
  "JOURNEY_RELEASES_API_URL",
  "JOURNEY_RETRY_PAUSE_SECONDS",
  "JOURNEY_SIGN_IN",
  "JOURNEY_SMOKE_SESSION_URL",
  "JOURNEY_TIMEOUT_SECONDS",
  "JOURNEY_WEB_DECISION_URL",
  "JOURNEY_WEB_SEARCH_URL",
  "JOURNEY_WEB_STATUTES_URL",
  "JOURNEY_WEB_URL",
  "LANDING_SITE",
  // Release pull request refresh: the main commit it plans from.
  "MAIN_SHA",
  "MARKETING_CAPTURE",
  "MARKETING_COMMIT",
  "MARKETING_THEME",
  "MATTER_ACTIVITY_USER_ID",
  "MATTER_ACTIVITY_WORKSPACE_ID",
  "MCP_APP_INPUT",
  "MCP_CANARY_BASE_URL",
  "MCP_CANARY_CONFIGURED_BASE_URL",
  "MCP_CANARY_ENVIRONMENT",
  "MCP_CANARY_FRONTEND_URL",
  "MCP_CANARY_MODE",
  "MCP_CANARY_REQUIRE_CREDENTIALS",
  "MCP_CANARY_TOKEN",
  "MERGE_GROUP_HEAD_REF",
  "MODE",
  "NETWORK_BASELINE_PURPOSE",
  "NETWORK_CANARY_URL",
  // Read-only npm summary receives the publishing jobs' needs context.
  "NPM_RELEASE_NEEDS",
  // The online index gate's child-process fixture receives its target here.
  "ONLINE_INDEX_TEST_NAME",
  "ONLINE_INDEX_TEST_NOW",
  "ONLINE_INDEX_TEST_TABLE",
  "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY",
  "OSV_SCANNER_MIRROR_RELEASE_URL",
  "OSV_SCANNER_PRIMARY_RELEASE_URL",
  "OSV_SCANNER_RELEASE_VERSION",
  "OSV_SCANNER_SHA256",
  // Tailwind lint cache configuration.
  "OXLINT_TAILWINDCSS_CACHE_DIR",
  "OXLINT_TAILWINDCSS_CACHE_READ_ONLY",
  "OXLINT_TAILWINDCSS_WORKER_REQUEST_TIMEOUT",
  // Worker-local custom lint reports, merged before the coverage census.
  "OXLINT_RULE_COVERAGE_PATH",
  // Historical package builds use current tooling against a separate source root.
  "PACK_SOURCE_ROOT",
  "PGLITE_TEST_SNAPSHOT",
  "PR_HEAD_SHA",
  "PR_TITLE",
  // ci-plan: the pull request is armed (auto-merge or the merge-armed label).
  "ARMED",
  "TESTED_TREE",
  "WORKFLOW_TREE",
  "PRODUCT_MEDIA_S3_BUCKET",
  "PROPERTY_ROLE_BACKFILL_BATCH_SIZE",
  "PROPERTY_TEST_NUM_RUNS_FACTOR",
  "PROPERTY_TEST_PATH",
  "PROPERTY_TEST_REDACT",
  "PROPERTY_TEST_SEED",
  "PROPERTY_TEST_TIME_LIMIT_MS",
  "PROPERTY_TEST_TIMEOUT_BASE_MS",
  "PROVIDER_REQUEST_COMBINATIONS",
  "PROVIDER_REQUEST_SHARD",
  "PUSH_BEFORE",
  "RAILWAY_API_TOKEN",
  "RAILWAY_PROJECT_TOKEN",
  "RAILWAY_SMOKE_API_URL",
  "RAILWAY_SMOKE_EXPECTED_COMMIT",
  "RAILWAY_SMOKE_WEB_URL",
  "RAILWAY_TEMPLATE_ENVIRONMENT",
  "RAILWAY_TEMPLATE_PROJECT_ID",
  // CI names the revision the convention ratchet measures as its base.
  "RATCHET_BASE_REF",
  "READ_FAULT_BASELINE",
  "RECORD_ANTHROPIC_API_KEY",
  "RECORD_BEDROCK_API_KEY",
  "RECORD_GOOGLE_API_KEY",
  "RECORD_MISTRAL_API_KEY",
  "RECORD_OPENAI_API_KEY",
  "RECORD_OPENROUTER_API_KEY",
  "REHEARSAL_BASE_DATABASE_URL",
  "REHEARSAL_BASE_IMAGE_REPOSITORY",
  "REHEARSAL_BASE_REF",
  "REHEARSAL_DECISIONS",
  "REHEARSAL_MIGRATE_BUDGET_SECONDS",
  "REHEARSAL_PRODUCTION_READY_URL",
  "REHEARSAL_WRITER_GAP_BUDGET_SECONDS",
  // Trusted release-proof controls passed between workflow steps.
  "PRODUCTION_WEB_IMAGE_DIGEST",
  "PROOF_MAIN_BASE",
  "RELEASE_CANDIDATE_CHECKER",
  "RELEASE_CANDIDATE_TREE_VERIFIER",
  "RELEASE_GATE_DIR",
  "RELEASE_HEALTH_TOKEN",
  // Release pull request refresh: open release numbers, the release to update,
  // its branch, whether main merges in, and the versioned staging tip.
  "RELEASE_NUMBERS",
  "RELEASE_PULL_REQUEST",
  "RELEASE_BRANCH",
  "MERGE_MAIN",
  "STAGED_HEAD",
  "RELEASE_PR_HEAD",
  "RELEASE_PROOF_REPOSITORY",
  "RELEASE_TREE_PROOF_VERIFIER",
  "REUSE_RUN",
  "RELEASE_REF",
  "REPO",
  "REPOSITORY",
  // Main PR-depth status publisher inputs.
  "RESULTS",
  "RETRY_ATTEMPTS",
  "RETRY_DELAYS_SECONDS",
  // scripts/retry.sh: `warning` for callers that tolerate the failure.
  "RETRY_FAILURE_LEVEL",
  // scripts/retry.sh: exit codes that are an answer, not a failure to retry.
  "RETRY_PASSTHROUGH_EXIT_CODES",
  // Credential used only by the restricted account canary.
  "REVIEW_ACCOUNT_PASSWORD",
  "RUN_ID",
  // Nightly issue reporter: workflow run linked from the failure issue.
  "RUN_URL",
  "SHA",
  "SMOKE_AI_JOURNEY",
  "SMOKE_AI_OPENAI_API_KEY",
  "SMOKE_API_URL",
  "SMOKE_TEST",
  // The source-fingerprint baseline generator reads the guard test's census.
  "SOURCE_FINGERPRINT_CENSUS_OUT",
  "STAGING_STATE",
  "STAGING_STATUS_WRITER",
  // CI names the target-branch revision the statute recall floor compares to.
  "STATUTE_RECALL_BASE_REF",
  "STELLA_AGENT_CAPTURE_LOG",
  "STELLA_COLLAB_TEST_REDIS_CONTAINER_ID",
  "STELLA_COLLAB_TEST_REDIS_URL",
  // Private loopback endpoint passed to the isolated corpus-suite preload.
  "STELLA_CORPUS_ENGINE_TEST_ENDPOINT",
  "STELLA_DESKTOP_DOWNLOAD_BASE_URL",
  "STELLA_DESKTOP_NOW_EPOCH",
  "STELLA_DESKTOP_RELEASE_API_PATH",
  "STELLA_DESKTOP_RELEASE_EXPECTED_TAG",
  "STELLA_DESKTOP_RETRY_PAUSE_SECONDS",
  "STELLA_DESKTOP_SMOKE_API_URL",
  "STELLA_DEV_INSTANCE",
  "STELLA_DOCKER_KEEPER_LABEL",
  "STELLA_INFRA_OFFSET",
  "STELLA_PORT_OFFSET",
  "STELLA_QUERY_PLAN_SCALE_PROFILE",
  // Development render census: verify React Refresh with isolated temporary modules.
  "STELLA_RENDER_CENSUS_HMR",
  "STELLA_RUN_CORPUS_ENGINE_TESTS",
  "STELLA_RUN_POSTGRES_TESTS",
  "STELLA_RUN_QUERY_PERF_TESTS",
  "STELLA_RUN_VALKEY_TESTS",
  "STELLA_SEED_ID_NAMESPACE",
  "STELLA_SEED_ORG_ID",
  "STELLA_SEED_USER_ID",
  "STELLA_TEST_LATEST_TAG",
  "STELLA_TEST_OMIT_ASSET",
  "STELLA_TEST_RELEASE_NUMBERS",
  "STELLA_UPDATE_PLAN_CONTRACTS",
  "STORED_AGENT_TEST_CREDENTIAL",
  "STORED_AGENT_TEST_VALUE",
  "SUITE_DEPTH",
  "TANSTACK_DRIFT_INSTALL_OUTCOME",
  "TEST_API_ERROR",
  "TEST_LATER",
  "CI_GENERATED_SOURCES_MANIFEST",
  // Check pool: the job context its step hands over and an optional
  // concurrency override; the pool strips the context before running checks.
  "CI_CHECK_POOL_NEEDS_FILE",
  "CI_CHECK_POOL_STEPS",
  "CI_CHECK_POOL_INPUTS",
  "CI_CHECK_POOL_TOKEN",
  "CI_CHECK_POOL_CONCURRENCY",
  // The job's start (epoch ms) when a caller knows it; else the pool reads
  // the runner's worker process.
  "CI_CHECK_POOL_JOB_STARTED_AT",
  // Comparison base supplied to every command launched by a CI check pool.
  "CI_COMPARISON_BASE",
  // <index>/<count>: the share of the check registry one ci-checks-rest leg runs.
  "CI_CHECK_POOL_PARTITION",
  // Test-only: the commit ci-checks-partition.test.ts compares the head with.
  "CI_CHECKS_PARTITION_BASE",
  // Generator families another job of the same CI run checks on this commit.
  "GENERATED_CHECKS_IN_OTHER_JOBS",
  // Generator families whose inputs the CI plan proved unchanged in this run.
  "GENERATED_CHECKS_UNCHANGED",
  // Queue proof outcomes and resolved hosted-runner image for static receipts.
  "CHECK_OUTCOMES",
  "ImageOS",
  "ImageVersion",
  // Internal handoff between the code-quality supervisor and its process group.
  "CODE_QUALITY_PROCESS_GROUP",
  // Lowers the code-check Turbo task count; the pre-push check sets it to 1.
  "CODE_CHECK_CONCURRENCY",
  // Replaces the detected code-check memory size (tests pin the plan with it).
  "CODE_CHECK_MEMORY_BYTES",
  // CI installer budget selected from restored package-cache contents.
  "CI_INSTALL_CACHE_RESTORED",
  "CI_POSTGRES_TEST_SELECTION",
  "CI_POSTGRES_TEST_SHARD",
  "POSTGRES_TEST_DURATIONS_FILE",
  "POSTGRES_JUNIT_FILE",
  "CHANGED_MARKDOWN",
  "TURBO_HASH",
  "TURBO_SCM_BASE",
  "TURN_OUTCOME_COMBINATIONS",
  "TURN_OUTCOME_SHARD",
  "UPDATE_CHAT_PROMPT_BASELINE",
  "UPDATE_PROVIDER_REQUEST_PATHS",
  "VERSION",
  // Web image build: the previous release image whose own assets carry forward.
  "PREVIOUS_WEB_IMAGE",
  // Release dependency-audit gate: a reasoned waiver and the remediation branch.
  "WAIVE_DEPENDENCY_AUDIT",
  "WAIVER_REASON",
  "FIX_BRANCH",
  // Shell fixtures for the dependency-audit gate and remediation scripts.
  "TEST_AUDIT_STATUS",
  "TEST_ASSESS_STATUS",
  "TEST_FIX_AVAILABLE",
  "TEST_OPEN_PRS",
  "TEST_ADVISORIES_REMAIN",
  "TEST_STALE",
  "TEST_PIN_REWRITE",
  "WXT_STELLA_ORIGINS",
]);

export const AMBIENT_ENV_KEYS = new Set([
  // Network clients conventionally inherit these proxy settings from the host.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "AWS_ACCESS_KEY_ID",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_EXECUTION_ENV",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CARGO_MANIFEST_DIR",
  "CARGO_PKG_VERSION",
  "CI",
  // Captured by the Docker transport owner and consumed by the Docker CLI.
  "DOCKER_CONFIG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "ECS_CONTAINER_METADATA_URI_V4",
  "GITHUB_TOKEN",
  "GH_REPO",
  "GH_TOKEN",
  // Test seam: the GitHub retry wrapper a status script calls.
  "GH_RETRY",
  "HOSTNAME",
  "NODE_ENV",
  // Read by the provider SDK; managed request tests verify it cannot enable logging.
  "OPENROUTER_DEBUG",
  "PATH",
  "RAILWAY_GIT_COMMIT_SHA",
  "STELLA_LOCAL_DEV",
  "TMPDIR",
  "TZ",
]);

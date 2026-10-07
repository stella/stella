/**
 * API source modules with outbound-capable transports.
 *
 * Paths are exact repository-relative source files under apps/api. The
 * inventory covers production TypeScript, TSX, and JavaScript sources,
 * including scripts, evals, dev utilities, and browser-delivered MCP app
 * modules; test suites, fixtures, generated assets, and dependencies are
 * outside this inventory. A transport key
 * names the imported runtime module or a platform network primitive. Type
 * only imports are not transport capabilities.
 */

export const OUTBOUND_TRANSPORT_CLASSES = [
  "third-party",
  "operator-configured-infrastructure",
  "vendor-sdk",
  "package-owned-client",
] as const;

export type OutboundTransportClass =
  (typeof OUTBOUND_TRANSPORT_CLASSES)[number];

export type OutboundTransportCensusEntry = {
  path: `apps/api/${string}`;
  class: OutboundTransportClass;
  reason: string;
  transports: readonly string[];
};

export const OUTBOUND_TRANSPORT_CENSUS = [
  {
    path: "apps/api/scripts/ai-provider-cassette-probe.ts",
    class: "vendor-sdk",
    reason:
      "Records a provider response through the configured model endpoint.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/seed-firm-knowledge.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Seeds a local API and uploads fixture data to reserved storage URLs.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/capture-parser-fixture.ts",
    class: "third-party",
    reason: "Captures a response from the selected public source.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/mcp-surface-token-calibration.ts",
    class: "vendor-sdk",
    reason: "Requests token counts from the configured Anthropic endpoint.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/record-provider-cassettes.ts",
    class: "vendor-sdk",
    reason: "Records requests and responses for configured model providers.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/record-eu-ecj-fixtures.ts",
    class: "third-party",
    reason: "Records public European case-law source responses.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/replay-provider-events-performer.ts",
    class: "third-party",
    reason: "Reads provider metadata for replayed events.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/chat-orientation-eval.ts",
    class: "third-party",
    reason:
      "Exercises the configured API and OpenRouter model catalog endpoints.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/scripts/provider-request-schemas.ts",
    class: "third-party",
    reason:
      "Downloads provider request schemas from published repositories and endpoints.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/api/src/agent-auth/id-jag.ts",
    class: "third-party",
    reason:
      "Requests identity assertions from the configured identity service.",
    transports: ["module:@stll/fetch", "module:jose"],
  },
  {
    path: "apps/api/src/handlers/case-law/decisions/dev-reparse.ts",
    class: "third-party",
    reason: "Reads decision content from the selected public publisher.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/case-law/ingestion/adapters/cz-us-throttle.ts",
    class: "third-party",
    reason: "Paces requests to the Czech court publisher.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
    class: "third-party",
    reason: "Sends paged and document requests to public court publishers.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/case-law/ingestion/adapters/test-utils.ts",
    class: "package-owned-client",
    reason: "Provides fixture request helpers for adapter checks.",
    transports: ["global:fetch", "module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/case-law/judges/import-cz-us-roster.ts",
    class: "third-party",
    reason: "Reads roster data from public court sites.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/entities/zip/download.ts",
    class: "operator-configured-infrastructure",
    reason: "Downloads entity archives from configured object storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/files/get.ts",
    class: "operator-configured-infrastructure",
    reason: "Streams file bytes from configured object storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/sharepoint/graph-client.ts",
    class: "third-party",
    reason: "Reads Microsoft Graph resources for connected accounts.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/sharepoint/graph-oauth.ts",
    class: "third-party",
    reason: "Exchanges credentials with Microsoft identity endpoints.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/handlers/soft-law/publisher-access.ts",
    class: "third-party",
    reason: "Sends publisher requests through the soft-law access policy.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/business-registries/dispatch.ts",
    class: "package-owned-client",
    reason: "Dispatches registry lookups through provider adapters.",
    transports: [
      "module:@stll/business-registries/ares",
      "module:@stll/business-registries/brreg",
      "module:@stll/business-registries/companies-house",
      "module:@stll/business-registries/denue",
      "module:@stll/business-registries/edgar",
      "module:@stll/business-registries/gcis",
      "module:@stll/business-registries/krs",
      "module:@stll/business-registries/orsr",
      "module:@stll/business-registries/prh",
      "module:@stll/business-registries/recherche-entreprises",
      "module:@stll/business-registries/rpo",
      "module:@stll/business-registries/vies",
    ],
  },
  {
    path: "apps/api/src/lib/business-registries/entity-checks.ts",
    class: "package-owned-client",
    reason: "Runs provider-backed registry entity checks.",
    transports: ["module:@stll/business-registries/entity-checks"],
  },
  {
    path: "apps/api/src/lib/business-registries/credentials.ts",
    class: "package-owned-client",
    reason: "Uses provider package exports to handle registry credentials.",
    transports: [
      "module:@stll/business-registries/companies-house",
      "module:@stll/business-registries/denue",
    ],
  },
  {
    path: "apps/api/src/lib/docx/lookup-fields.ts",
    class: "package-owned-client",
    reason:
      "Uses registry package format and validation helpers in document fields.",
    transports: [
      "module:@stll/business-registries/ares",
      "module:@stll/business-registries/ares/court-names",
      "module:@stll/business-registries/ares/default-format",
      "module:@stll/business-registries/ares/legal-forms",
      "module:@stll/business-registries/brreg",
      "module:@stll/business-registries/brreg/identifier-format",
      "module:@stll/business-registries/companies-house",
      "module:@stll/business-registries/default-formats",
      "module:@stll/business-registries/denue",
      "module:@stll/business-registries/edgar",
      "module:@stll/business-registries/edgar/identifier-format",
      "module:@stll/business-registries/format-clauses",
      "module:@stll/business-registries/gcis",
      "module:@stll/business-registries/krs",
      "module:@stll/business-registries/orsr",
      "module:@stll/business-registries/orsr/court-file",
      "module:@stll/business-registries/orsr/court-names",
      "module:@stll/business-registries/orsr/default-format",
      "module:@stll/business-registries/orsr/identifier-format",
      "module:@stll/business-registries/prh",
      "module:@stll/business-registries/recherche-entreprises",
      "module:@stll/business-registries/recherche-entreprises/identifier-format",
      "module:@stll/business-registries/rpo",
      "module:@stll/business-registries/vies",
    ],
  },
  {
    path: "apps/api/src/lib/email/inbound/ses.ts",
    class: "vendor-sdk",
    reason: "Reads inbound email attachments from the configured AWS account.",
    transports: ["module:@aws-sdk/client-s3"],
  },
  {
    path: "apps/api/src/lib/email/inbound/sqs.ts",
    class: "vendor-sdk",
    reason:
      "Reads inbound email queue messages from the configured AWS account.",
    transports: ["module:@aws-sdk/client-sqs"],
  },
  {
    path: "apps/api/src/lib/email/ses.ts",
    class: "vendor-sdk",
    reason: "Sends email through the configured AWS account.",
    transports: ["module:@aws-sdk/client-sesv2"],
  },
  {
    path: "apps/api/src/lib/email/smtp.ts",
    class: "operator-configured-infrastructure",
    reason: "Sends email through the configured SMTP relay.",
    transports: ["module:nodemailer"],
  },
  {
    path: "apps/api/src/lib/db/ebs-balance-reader.ts",
    class: "vendor-sdk",
    reason: "Reads storage balance metrics from the configured AWS account.",
    transports: ["module:@aws-sdk/client-cloudwatch"],
  },
  {
    path: "apps/api/src/lib/chat/openrouter-credential.ts",
    class: "vendor-sdk",
    reason: "Obtains federated credentials and exchanges them with OpenRouter.",
    transports: ["module:@aws-sdk/client-sts", "module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/chat/provider-data-policy.ts",
    class: "third-party",
    reason:
      "Sends provider checks and completions to configured OpenRouter endpoints.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/chat/projections.ts",
    class: "package-owned-client",
    reason: "Uses a registry package client when projecting native chat tools.",
    transports: ["module:@stll/business-registries/entity-checks"],
  },
  {
    path: "apps/api/src/lib/deepl/client.ts",
    class: "third-party",
    reason: "Sends translation requests to DeepL endpoints.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/web-search/jina.ts",
    class: "third-party",
    reason: "Sends validation and page requests to Jina endpoints.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/web-search/tavily.ts",
    class: "third-party",
    reason: "Sends search requests to Tavily endpoints.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/workflow/decisions/system-one.ts",
    class: "third-party",
    reason:
      "Sends structured evaluation requests to the configured System One endpoint.",
    transports: ["global:fetch", "module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/errors/tagged-errors.ts",
    class: "package-owned-client",
    reason: "Classifies failures produced by the shared HTTP client.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/files/gotenberg.ts",
    class: "operator-configured-infrastructure",
    reason: "Submits document conversion requests to the configured converter.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/github/github-write.ts",
    class: "third-party",
    reason: "Sends repository operations to the GitHub API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/health/probe-document-converter.ts",
    class: "operator-configured-infrastructure",
    reason: "Checks availability of the configured document converter.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/hosted-usage-provider/client.ts",
    class: "third-party",
    reason: "Creates hosted usage sessions with the configured provider.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/lib/legal-search/boe-client.ts",
    class: "package-owned-client",
    reason: "Provides permit-bound requests to the BOE service client.",
    transports: ["module:@stll/boe"],
  },
  {
    path: "apps/api/src/handlers/legislation/boe-error.ts",
    class: "package-owned-client",
    reason: "Maps BOE package response errors into API errors.",
    transports: ["module:@stll/boe"],
  },
  {
    path: "apps/api/src/handlers/legislation/boe/related-laws/list.ts",
    class: "package-owned-client",
    reason: "Uses a BOE package value when shaping related law results.",
    transports: ["module:@stll/boe"],
  },
  {
    path: "apps/api/src/handlers/chat/tools/boe-tools.ts",
    class: "package-owned-client",
    reason: "Uses a BOE package value when shaping native tool results.",
    transports: ["module:@stll/boe"],
  },
  {
    path: "apps/api/src/mcp/research-admin-tools.ts",
    class: "package-owned-client",
    reason: "Uses BOE package values when defining research tools.",
    transports: ["module:@stll/boe"],
  },
  {
    path: "apps/api/src/handlers/contacts/contact-import-receipt.ts",
    class: "package-owned-client",
    reason: "Uses registry package validators when parsing contact receipts.",
    transports: [
      "module:@stll/business-registries/cnpj",
      "module:@stll/business-registries/cpf",
    ],
  },
  {
    path: "apps/api/src/handlers/desktop-registry/service.ts",
    class: "package-owned-client",
    reason: "Uses a registry package format catalog in the desktop service.",
    transports: ["module:@stll/business-registries/default-formats"],
  },
  {
    path: "apps/api/src/handlers/legislation/boe/search.ts",
    class: "package-owned-client",
    reason: "Uses BOE package limits and errors when shaping search requests.",
    transports: ["module:@stll/boe"],
  },
  {
    path: "apps/api/src/scripts/image-smoke.ts",
    class: "package-owned-client",
    reason: "Uses a registry package validator while checking image fixtures.",
    transports: ["module:@stll/business-registries/ares"],
  },
  {
    path: "apps/api/src/lib/legal-search/corpus-index-client.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Queries the configured corpus index service and records registry request metadata.",
    transports: [
      "module:@stll/business-registries/shared/request-observer",
      "module:@stll/fetch",
    ],
  },
  {
    path: "apps/api/src/lib/visual-preview.ts",
    class: "vendor-sdk",
    reason: "Invokes the configured AWS visual preview function.",
    transports: ["module:@aws-sdk/client-lambda"],
  },
  {
    path: "apps/api/src/lib/scheduler/tasks/inbound-mail-receive.ts",
    class: "vendor-sdk",
    reason:
      "Receives inbound mail notifications from the configured AWS account.",
    transports: ["module:@aws-sdk/client-sqs"],
  },
  {
    path: "apps/api/src/lib/observability/otel.ts",
    class: "operator-configured-infrastructure",
    reason: "Exports sanitized logs to the configured OTLP endpoint.",
    transports: ["module:@opentelemetry/exporter-logs-otlp-http"],
  },
  {
    path: "apps/api/src/lib/stella-openrouter-text-adapter.ts",
    class: "vendor-sdk",
    reason: "Sends model requests through the OpenRouter adapter and client.",
    transports: ["module:@openrouter/sdk", "module:@tanstack/ai-openrouter"],
  },
  {
    path: "apps/api/src/lib/tanstack-ai-models.ts",
    class: "vendor-sdk",
    reason:
      "Creates configured Anthropic, Bedrock, Gemini, Mistral, and OpenAI adapters.",
    transports: [
      "module:@google/genai",
      "module:@smithy/fetch-http-handler",
      "module:@tanstack/ai-anthropic",
      "module:@tanstack/ai-bedrock",
      "module:@tanstack/ai-gemini",
      "module:@tanstack/ai-mistral",
      "module:@tanstack/ai-openai",
    ],
  },
  {
    path: "apps/api/src/lib/s3-presign.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Signs and transfers objects using configured S3-compatible services.",
    transports: [
      "module:@aws-sdk/client-s3",
      "module:@aws-sdk/client-sts",
      "module:@stll/fetch",
    ],
  },
  {
    path: "apps/api/src/lib/s3.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads and writes objects using configured S3-compatible services.",
    transports: [
      "global:fetch",
      "module:@aws-sdk/client-s3",
      "module:@stll/fetch",
      "module:bun",
    ],
  },
  {
    path: "apps/api/src/lib/safe-outbound-fetch.ts",
    class: "package-owned-client",
    reason:
      "Validates destinations and pins resolved addresses for HTTP requests.",
    transports: ["module:node:http", "module:node:https"],
  },
  {
    path: "apps/api/src/mcp/apps/document-upload/app.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Uploads documents to reserved object storage URLs in the browser app.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/mcp/apps/file-comparison/app.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Uploads comparison inputs to reserved object storage URLs in the browser app.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/mcp/auth.ts",
    class: "vendor-sdk",
    reason:
      "Verifies MCP resource access tokens through the OAuth provider client.",
    transports: ["module:@better-auth/oauth-provider/resource-client"],
  },
  {
    path: "apps/api/src/lib/auth.ts",
    class: "vendor-sdk",
    reason: "Configures Google and Microsoft social sign-in flows.",
    transports: [
      "module:@better-auth/cimd",
      "module:@better-auth/cimd/node",
      "module:better-auth",
      "module:better-auth/adapters/drizzle",
      "module:better-auth/api",
      "module:better-auth/plugins",
    ],
  },
  {
    path: "apps/api/src/lib/mcp-upstream/connections.ts",
    class: "third-party",
    reason: "Connects to configured MCP servers for discovery and tool calls.",
    transports: ["global:fetch", "module:@tanstack/ai-mcp"],
  },
  {
    path: "apps/api/src/lib/auth/demo-account-policy.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth middleware APIs for demo account policy.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/auth/session-bearer.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth plugin APIs for bearer session handling.",
    transports: ["module:better-auth/plugins"],
  },
  {
    path: "apps/api/src/lib/auth/oauth-consent-info.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth middleware for OAuth consent information.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/auth/review-account-plugin.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth APIs for review account handling.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/auth/registration-adapter.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth APIs for account registration handling.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/auth/session-lifetime.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth APIs and database helpers for session lifetimes.",
    transports: ["module:better-auth/api", "module:better-auth/db"],
  },
  {
    path: "apps/api/src/lib/auth/oauth-registration-policy.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth middleware for OAuth registration policy.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/auth/demo-account-hooks.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth middleware for demo account hooks.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/user-shortcuts.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth API errors for user shortcut handling.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/selfhost-auth.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth API errors for self-hosted authentication.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/membership-role-invariants.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth API errors for membership role checks.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/time-entry-offboarding.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth API errors when handling offboarding.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/rate-limit/otp-account-budget.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth middleware in OTP account budget policy.",
    transports: ["module:better-auth/api"],
  },
  {
    path: "apps/api/src/lib/machine-api-keys/personal-lifecycle.ts",
    class: "vendor-sdk",
    reason: "Uses Better Auth credential generation helpers for personal keys.",
    transports: ["module:better-auth/crypto"],
  },
  {
    path: "apps/api/src/lib/infosoud/client.ts",
    class: "package-owned-client",
    reason: "Creates the shared InfoSoud registry client.",
    transports: ["module:@stll/infosoud"],
  },
  {
    path: "apps/api/src/lib/infosoud/agenda-import.ts",
    class: "package-owned-client",
    reason: "Converts InfoSoud package response values for agenda records.",
    transports: ["module:@stll/infosoud"],
  },
  {
    path: "apps/api/src/lib/infosoud/result.ts",
    class: "package-owned-client",
    reason: "Maps InfoSoud package response values into API errors.",
    transports: ["module:@stll/infosoud"],
  },
  {
    path: "apps/api/src/handlers/workspaces/infosoud-courts.ts",
    class: "package-owned-client",
    reason: "Uses the shared InfoSoud client for court data reads.",
    transports: ["module:@stll/infosoud"],
  },
  {
    path: "apps/api/src/handlers/workspaces/infosoud-common.ts",
    class: "package-owned-client",
    reason: "Uses InfoSoud package errors when shaping workspace handlers.",
    transports: ["module:@stll/infosoud"],
  },
  {
    path: "apps/api/src/lib/analytics/posthog-node.ts",
    class: "vendor-sdk",
    reason: "Sends configured analytics events to the PostHog service.",
    transports: ["module:posthog-node"],
  },
  {
    path: "apps/api/src/lib/email/inbound/authentication.ts",
    class: "vendor-sdk",
    reason:
      "Validates inbound mail authentication through the mail protocol library.",
    transports: ["module:mailauth"],
  },
  {
    path: "apps/api/src/scripts/mcp-canary.ts",
    class: "third-party",
    reason: "Exercises requests to configured MCP service endpoints.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/scripts/post-deploy-response-policy.ts",
    class: "operator-configured-infrastructure",
    reason: "Checks response behavior at the deployed API origin.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/scripts/post-deploy-smoke.ts",
    class: "operator-configured-infrastructure",
    reason: "Runs smoke requests against the configured deployment origin.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/api/src/scripts/citation-probe.ts",
    class: "third-party",
    reason:
      "Reads public publisher records and stores probe artifacts in configured object storage.",
    transports: ["global:Bun.S3Client", "module:@stll/fetch"],
  },
  {
    path: "apps/api/src/scripts/better-auth-sign-in-replay.ts",
    class: "operator-configured-infrastructure",
    reason: "Runs an authentication replay against the configured API origin.",
    transports: [
      "global:fetch",
      "module:better-auth",
      "module:better-auth/adapters/drizzle",
      "module:better-auth/plugins",
      "module:bun",
    ],
  },
  {
    path: "apps/api/scripts/seed-reset.ts",
    class: "operator-configured-infrastructure",
    reason: "Runs the database reset using Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/scripts/decision-analysis.db.ts",
    class: "operator-configured-infrastructure",
    reason: "Queries the configured database for decision analysis.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/scripts/better-auth-migration-audit.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads migration state through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/scripts/seed-migration-rehearsal.ts",
    class: "operator-configured-infrastructure",
    reason: "Runs migration rehearsal queries through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/scripts/better-auth-17-backfill.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads and writes migration records through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/scripts/database-census.ts",
    class: "operator-configured-infrastructure",
    reason: "Collects database schema information through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/scripts/better-auth-microsoft-identity-map.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads identity mapping data through Bun SQL connections.",
    transports: ["module:bun", "module:jose"],
  },
  {
    path: "apps/api/src/lib/public-law-read-db.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads public law data through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/lib/redis-client.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Connects to the configured Redis service through Bun runtime clients.",
    transports: ["module:bullmq", "module:bun"],
  },
  {
    path: "apps/api/src/lib/scheduler/bullmq.ts",
    class: "operator-configured-infrastructure",
    reason: "Dispatches scheduled jobs through the configured queue service.",
    transports: ["module:bullmq"],
  },
  {
    path: "apps/api/src/lib/bullmq-queue.ts",
    class: "operator-configured-infrastructure",
    reason: "Provides queue and worker clients for the configured broker.",
    transports: ["module:bullmq"],
  },
  {
    path: "apps/api/src/lib/workflow-queue.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Creates background workflow jobs through the configured queue service.",
    transports: ["module:bullmq"],
  },
  {
    path: "apps/api/src/lib/health/database-login-probe.ts",
    class: "operator-configured-infrastructure",
    reason: "Checks database access through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/lib/case-law/maintenance-lane.ts",
    class: "operator-configured-infrastructure",
    reason: "Opens maintenance database connections through Bun SQL.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/db/long-running-connection.ts",
    class: "operator-configured-infrastructure",
    reason: "Opens long-running database connections through Bun SQL.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/db/migrate.ts",
    class: "operator-configured-infrastructure",
    reason: "Runs database migrations through Bun SQL connections.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/db/root.ts",
    class: "operator-configured-infrastructure",
    reason: "Creates root database connections through Bun SQL.",
    transports: ["module:bun"],
  },
  {
    path: "apps/api/src/db/online-index-observer.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads online index state through Bun SQL connections.",
    transports: ["module:bun"],
  },
] as const satisfies readonly OutboundTransportCensusEntry[];

export type OutboundPermitGrantOwner = {
  path: `apps/api/${string}`;
  reason: string;
};

/** Direct request boundaries allowed to create outbound permits. */
export const OUTBOUND_PERMIT_GRANT_OWNERS = [
  {
    path: "apps/api/src/handlers/ai-config/validate-provider.ts",
    reason: "Issues request authority for provider credential validation.",
  },
  {
    path: "apps/api/src/handlers/case-law/public-routes.ts",
    reason: "Direct boundary for public case-law reads.",
  },
  {
    path: "apps/api/src/handlers/chat/send-message.ts",
    reason:
      "Issues request authority for external MCP discovery during a chat turn.",
  },
  {
    path: "apps/api/src/handlers/chat/tools/boe-tools.ts",
    reason: "Native chat tool boundary for BOE requests.",
  },
  {
    path: "apps/api/src/handlers/chat/tools/business-registry-tools.ts",
    reason: "Native chat tool boundary for registry requests.",
  },
  {
    path: "apps/api/src/handlers/chat/tools/counterparty-check-tools.ts",
    reason: "Native chat tool boundary for counterparty checks.",
  },
  {
    path: "apps/api/src/handlers/chat/tools/template-tools.ts",
    reason: "Native chat tool boundary for template lookups.",
  },
  {
    path: "apps/api/src/handlers/contacts/business-registries/check.ts",
    reason: "Direct route boundary for registry checks.",
  },
  {
    path: "apps/api/src/handlers/contacts/business-registries/lookup.ts",
    reason: "Direct route boundary for registry lookups.",
  },
  {
    path: "apps/api/src/handlers/desktop-registry/service.ts",
    reason: "Direct service boundary for desktop registry requests.",
  },
  {
    path: "apps/api/src/handlers/entities/pdf-signing-certificate.ts",
    reason: "Issues request authority for the PDF certificate request.",
  },
  {
    path: "apps/api/src/handlers/entities/pdf-signing-signature.ts",
    reason: "Issues request authority for the PDF signature request.",
  },
  {
    path: "apps/api/src/handlers/external-preview/preview.ts",
    reason: "Issues request authority for the external preview routes.",
  },
  {
    path: "apps/api/src/handlers/legislation/boe/law-structure/get.ts",
    reason: "Direct route boundary for BOE law structure reads.",
  },
  {
    path: "apps/api/src/handlers/legislation/boe/laws/get.ts",
    reason: "Direct route boundary for consolidated BOE law reads.",
  },
  {
    path: "apps/api/src/handlers/legislation/boe/related-laws/list.ts",
    reason: "Direct route boundary for related BOE law reads.",
  },
  {
    path: "apps/api/src/handlers/legislation/boe/search.ts",
    reason: "Direct route boundary for BOE search requests.",
  },
  {
    path: "apps/api/src/handlers/legislation/boe/text-block/get.ts",
    reason: "Direct route boundary for BOE text block reads.",
  },
  {
    path: "apps/api/src/handlers/legislation/borme/summary/get.ts",
    reason: "Direct route boundary for BORME summary reads.",
  },
  {
    path: "apps/api/src/handlers/mcp-connectors/approve-authorization.ts",
    reason: "Issues request authority for an explicit authorization review.",
  },
  {
    path: "apps/api/src/handlers/mcp-connectors/connect.ts",
    reason: "Issues request authority for a user connector setup request.",
  },
  {
    path: "apps/api/src/handlers/mcp-connectors/create-connection.ts",
    reason: "Issues request authority for a user connection request.",
  },
  {
    path: "apps/api/src/handlers/mcp-connectors/create-connector.ts",
    reason: "Issues request authority for connector creation probes.",
  },
  {
    path: "apps/api/src/handlers/mcp-connectors/oauth-callback.ts",
    reason: "Issues request authority for the validated OAuth callback.",
  },
  {
    path: "apps/api/src/handlers/mcp-connectors/probe-connector.ts",
    reason: "Issues request authority for the connector probe route.",
  },
  {
    path: "apps/api/src/handlers/organization-settings/business-registry-credentials.ts",
    reason: "Direct route boundary for registry credential checks.",
  },
  {
    path: "apps/api/src/handlers/organization-settings/update-ai-config.ts",
    reason: "Issues request authority for provider configuration validation.",
  },
  {
    path: "apps/api/src/handlers/reports/report-export-queue.ts",
    reason: "User-requested export job boundary for external data.",
  },
  {
    path: "apps/api/src/handlers/skills/discover.ts",
    reason: "Issues request authority for skill discovery requests.",
  },
  {
    path: "apps/api/src/handlers/skills/from-url/import.ts",
    reason: "Issues request authority for skill URL imports.",
  },
  {
    path: "apps/api/src/handlers/skills/import.ts",
    reason: "Issues request authority for skill catalogue imports.",
  },
  {
    path: "apps/api/src/handlers/templates/fill.ts",
    reason: "Direct route boundary for template fills.",
  },
  {
    path: "apps/api/src/handlers/templates/fills/create.ts",
    reason: "Direct route boundary for template fill creation.",
  },
  {
    path: "apps/api/src/handlers/templates/lookups/preview.ts",
    reason: "Direct route boundary for template lookup previews.",
  },
  {
    path: "apps/api/src/lib/scheduler/tasks/sanctions-refresh.ts",
    reason: "Issues request authority for the scheduled sanctions refresh.",
  },
  {
    path: "apps/api/src/lib/templates/fill-by-id-logic.ts",
    reason: "Direct service boundary for template fills by identifier.",
  },
  {
    path: "apps/api/src/lib/templates/fill-preview-logic.ts",
    reason: "Direct service boundary for template fill previews.",
  },
  {
    path: "apps/api/src/mcp/context.ts",
    reason: "Direct MCP transport boundary for external data tools.",
  },
  {
    path: "apps/api/src/scripts/better-auth-microsoft-identity-map.ts",
    reason:
      "Issues request authority for the operator identity mapping command.",
  },
  {
    path: "apps/api/src/scripts/fetch-ocr-models.ts",
    reason: "Issues request authority for operator-requested model downloads.",
  },
  {
    path: "apps/api/src/scripts/subset-stamp-fonts.ts",
    reason: "Issues request authority for operator-requested font downloads.",
  },
] as const satisfies readonly OutboundPermitGrantOwner[];

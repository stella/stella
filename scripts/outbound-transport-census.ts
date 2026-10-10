/**
 * Production source modules with outbound-capable transports.
 *
 * The existing API inventory includes operator scripts and client bundles;
 * additional surfaces are apps/collab/src, apps/web/src and package src roots.
 * Tests, scripts, e2e and fixtures are excluded from the additional surfaces.
 * Paths are exact repository-relative TypeScript, TSX and JavaScript sources.
 * A transport key
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
  path:
    | `apps/api/${string}`
    | `apps/${"collab" | "web"}/src/${string}`
    | `packages/${string}/src/${string}`;
  class: OutboundTransportClass;
  reason: string;
  transports: readonly string[];
};

export const OUTBOUND_TRANSPORT_CENSUS = [
  {
    path: "packages/start-runtime/src/local-module-loader.ts",
    class: "package-owned-client",
    reason:
      "Imports trusted local modules after resolving entry paths inside a declared root.",
    transports: ["local:module-import"],
  },
  {
    path: "packages/start-runtime/src/runtime.ts",
    class: "package-owned-client",
    reason: "Verifies emitted server modules through the bounded local loader.",
    transports: ["local:module-loader"],
  },
  {
    path: "apps/web/src/runtime.ts",
    class: "package-owned-client",
    reason:
      "Loads the emitted web server entry through the bounded local loader.",
    transports: ["local:module-loader"],
  },
  {
    path: "apps/api/scripts/lib/enumerate-safe-handlers.ts",
    class: "operator-configured-infrastructure",
    reason: "Loads handler modules inside the repository handlers directory.",
    transports: ["local:module-loader"],
  },
  {
    path: "apps/api/scripts/record-docx-engine-parity.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Loads the selected archived engine inside the recorder's temporary directory.",
    transports: ["local:module-loader"],
  },
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
    reason: "Stubs fetch with fixture responses for adapter checks.",
    transports: ["global:fetch"],
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
    transports: [
      "module:node:dns/promises",
      "module:node:http",
      "module:node:https",
    ],
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
    transports: ["module:mailauth", "module:node:dns/promises"],
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
  {
    path: "apps/collab/src/server.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Posts collaboration requests to the configured API and uses WebSocket transport for collaboration sessions.",
    transports: ["global:WebSocket", "global:fetch"],
  },
  {
    path: "apps/web/src/boot-prefetch.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Prefetches authentication state from the configured API with the boot cancellation policy.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/web/src/components/ai-suggestions/document-review-proposal-stream.ts",
    class: "operator-configured-infrastructure",
    reason: "Streams review proposals from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/api-version-mismatch-refresh.tsx",
    class: "operator-configured-infrastructure",
    reason:
      "Reads the configured API health response to detect version changes.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/auth/sign-in-panel.tsx",
    class: "operator-configured-infrastructure",
    reason: "Submits email registration to the configured authentication API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/autocomplete/use-autocomplete-stream.ts",
    class: "operator-configured-infrastructure",
    reason: "Streams autocomplete responses from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/chat/message-export-menu.tsx",
    class: "operator-configured-infrastructure",
    reason: "Downloads chat exports from API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/company-registry-preview.tsx",
    class: "package-owned-client",
    reason:
      "Uses standalone registry court and legal-form labels; these imports make no requests.",
    transports: [
      "module:@stll/business-registries/ares/court-names",
      "module:@stll/business-registries/ares/legal-forms",
    ],
  },
  {
    path: "apps/web/src/components/company-specification.tsx",
    class: "package-owned-client",
    reason:
      "Uses standalone registry formatting definitions; these imports make no requests.",
    transports: ["module:@stll/business-registries/default-formats"],
  },
  {
    path: "apps/web/src/routes/dev/-components/autocomplete-playground.tsx",
    class: "operator-configured-infrastructure",
    reason: "Exercises autocomplete streaming through the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/docx/use-edit-session.ts",
    class: "operator-configured-infrastructure",
    reason: "Downloads edit-session documents from API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/docx/use-folio-collaboration-room.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Sends collaboration requests to the configured API and downloads seed documents.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/inspector/external-reference-panel.tsx",
    class: "operator-configured-infrastructure",
    reason: "Reads referenced content through the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/inspector/file-download-service.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Downloads matter files through the configured API and its storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/inspector/review-export-menu.tsx",
    class: "operator-configured-infrastructure",
    reason: "Downloads review exports from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/pdf/peek/peek-pdf-print.ts",
    class: "operator-configured-infrastructure",
    reason: "Downloads print-ready PDF bytes from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/search-company-result.logic.ts",
    class: "package-owned-client",
    reason:
      "Uses standalone registry identifier utilities; these imports make no requests.",
    transports: [
      "module:@stll/business-registries/krs/number",
      "module:@stll/business-registries/vies/validation",
    ],
  },
  {
    path: "apps/web/src/components/selfhost-update-banner.tsx",
    class: "third-party",
    reason: "Reads public GitHub release metadata to announce new versions.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/templates/registry-format-config.ts",
    class: "package-owned-client",
    reason:
      "Uses standalone registry formatting and identifier utilities; these imports make no requests.",
    transports: [
      "module:@stll/business-registries/ares/court-names",
      "module:@stll/business-registries/ares/default-format",
      "module:@stll/business-registries/brreg/identifier-format",
      "module:@stll/business-registries/default-formats",
      "module:@stll/business-registries/edgar/identifier-format",
      "module:@stll/business-registries/orsr/court-names",
      "module:@stll/business-registries/orsr/default-format",
      "module:@stll/business-registries/orsr/identifier-format",
      "module:@stll/business-registries/recherche-entreprises/identifier-format",
    ],
  },
  {
    path: "apps/web/src/components/workspaces/request-manual-ocr.ts",
    class: "operator-configured-infrastructure",
    reason: "Submits manual OCR requests to the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/components/workspaces/row-actions.tsx",
    class: "operator-configured-infrastructure",
    reason:
      "Downloads entity archives and OCR exports from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/features/case-law/queries/decision-analysis.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads decision analysis responses from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/features/chat/chat-fetch.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Sends chat requests to the configured API with the chat timeout policy.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/features/knowledge/public/tools/tool-contribute-page.tsx",
    class: "third-party",
    reason: "Reads GitHub commit metadata for a public tool contribution.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/features/statutes/statute-sitemap.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads public statute sitemap metadata from the configured API.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/web/src/lib/auth-client.ts",
    class: "vendor-sdk",
    reason:
      "Sends authentication requests through Better Auth to the configured API.",
    transports: [
      "module:@stll/fetch",
      "module:better-auth/client/plugins",
      "module:better-auth/react",
    ],
  },
  {
    path: "apps/web/src/lib/desktop-bridge.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Reads the desktop bridge through its configured loopback transport.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/dev-otp.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads development OTP responses from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/files/queries.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads and saves email attachments through the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/files/storage-fetch.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Reads file bytes from API-issued storage URLs with purpose-specific errors.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/files/upload-entity-version.ts",
    class: "operator-configured-infrastructure",
    reason: "Uploads replacement file versions to API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/knowledge/queries.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads knowledge documents from API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/public-law-sitemap.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads public law sitemap shards from the configured API.",
    transports: ["global:fetch"],
  },
  {
    path: "apps/web/src/lib/public-tools-github-content.ts",
    class: "third-party",
    reason: "Reads public tool content from validated GitHub URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/user-events-sse.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads user event streams from the configured API.",
    transports: ["global:EventSource"],
  },
  {
    path: "apps/web/src/lib/workspace-sse.ts",
    class: "operator-configured-infrastructure",
    reason: "Reads matter event streams from the configured API.",
    transports: ["global:EventSource", "module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/workspaces/mutations/use-create-file-entities.ts",
    class: "operator-configured-infrastructure",
    reason: "Uploads new matter files to API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/lib/workspaces/time-entries-api.ts",
    class: "operator-configured-infrastructure",
    reason: "Sends time-entry requests to the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/routes/_protected.contacts/-procuracao-extraction.tsx",
    class: "operator-configured-infrastructure",
    reason: "Uploads extraction source documents to API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-pdf-download-button.tsx",
    class: "operator-configured-infrastructure",
    reason: "Downloads invoice PDFs from API-issued storage URLs.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar.tsx",
    class: "operator-configured-infrastructure",
    reason: "Downloads matter view exports from the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/routes/agent-claim.tsx",
    class: "operator-configured-infrastructure",
    reason: "Confirms agent identity claims through the configured API.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "apps/web/src/routes/knowledge/-components/template-wizard.tsx",
    class: "package-owned-client",
    reason:
      "Uses standalone registry formatting definitions; these imports make no requests.",
    transports: ["module:@stll/business-registries/default-formats"],
  },
  {
    path: "packages/agent-engine/src/bun-docker/api.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Sends Docker API requests over the configured Unix socket with existing cancellation deadlines.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/boe/src/client.ts",
    class: "package-owned-client",
    reason:
      "Published standalone BOE client owns its public-source transport and request deadline.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/business-registries/src/shared/http.ts",
    class: "package-owned-client",
    reason:
      "Published standalone registry clients share this transport, cancellation and request observation owner.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/cli/src/auth/loopback-listener.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns the inbound loopback HTTP listener for OAuth callbacks; it makes no outbound requests.",
    transports: ["module:node:http"],
  },
  {
    path: "packages/cli/src/auth/oauth-client-registration.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns OAuth client registration requests to discovered endpoints.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/cli/src/auth/oauth-metadata.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns OAuth authorization-server metadata discovery.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/cli/src/auth/token-exchange.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns OAuth token exchange and refresh requests to discovered endpoints.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/cli/src/cli-release-channel.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns public release-channel metadata reads with an injectable transport.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/cli/src/compatibility.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns compatibility discovery against the configured server.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/cli/src/mcp-client.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI owns MCP transport and observes response evidence and action-admission refusals.",
    transports: ["global:fetch", "module:@modelcontextprotocol/client"],
  },
  {
    path: "packages/cli/src/upload-document.ts",
    class: "package-owned-client",
    reason:
      "Standalone CLI uploads document bytes to server-issued storage URLs with its upload deadline.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/fetch/src/index.ts",
    class: "package-owned-client",
    reason:
      "Shared fetch owner resolves the runtime transport and applies caller-selected header or idle deadlines.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/infosoud/src/client.ts",
    class: "package-owned-client",
    reason:
      "Published standalone InfoSoud client owns injected transport, throttling and request deadlines.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/permissions/src/index.ts",
    class: "package-owned-client",
    reason:
      "Uses Better Auth access-control definitions; this import makes no requests.",
    transports: ["module:better-auth/plugins/access"],
  },
  {
    path: "packages/scripts/src/agent-session.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Probes and seeds the configured local API for development agent sessions.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/scripts/src/auth-md-spec-drift.ts",
    class: "third-party",
    reason:
      "Reads the public authentication metadata specification for drift checks.",
    transports: ["global:fetch"],
  },
  {
    path: "packages/scripts/src/dev-runner.ts",
    class: "operator-configured-infrastructure",
    reason:
      "Probes development service endpoints and local TCP ports for the configured stack.",
    transports: ["global:fetch", "module:node:net"],
  },
  {
    path: "packages/scripts/src/model-catalog-benchmarks-gen.ts",
    class: "third-party",
    reason:
      "Reads public benchmark data with the shared timeout and bounded-response policies.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "packages/scripts/src/model-catalog-snapshot.ts",
    class: "third-party",
    reason:
      "Reads public model catalog snapshots with the shared timeout owner.",
    transports: ["module:@stll/fetch"],
  },
  {
    path: "packages/scripts/src/model-catalog-upstream.ts",
    class: "third-party",
    reason: "Reads public upstream model metadata for the committed catalog.",
    transports: ["global:fetch"],
  },
] as const satisfies readonly OutboundTransportCensusEntry[];

export type OutboundPermitGrantOwner = {
  path: `apps/api/${string}`;
  reason: string;
};

/** Direct request boundaries allowed to create outbound permits. */
export const OUTBOUND_PERMIT_GRANT_OWNERS = [
  {
    path: "apps/api/src/handlers/chat/tools/secret-tools.ts",
    reason: "Native chat tool boundary for a scoped connector request.",
  },
  {
    path: "apps/api/src/handlers/catalogue/install.ts",
    reason: "Issues request authority for catalogue skill installation.",
  },
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

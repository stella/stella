import type { ExternalContractEntry } from "./types";

export const EXTERNAL_SYSTEM_IDS = [
  "llm-providers",
  "legal-publishers",
  "identity-services",
  "microsoft-graph",
  "s3-compatible",
  "aws-services",
  "smtp",
  "deepl",
  "jina",
  "tavily",
  "system-one",
  "gotenberg",
  "github",
  "polar",
  "quickwit",
  "otlp",
  "better-auth",
  "mcp-servers",
  "posthog",
  "mail-dns",
  "postgres",
  "valkey",
  "boe",
  "business-registries",
  "infosoud",
  "custom-llm-adapters",
  "aws-s3",
  "local-runtime",
  "stella-api",
  "http-transport",
  "desktop-bridge",
  "docker-engine",
  "npm-registry",
  "development-services",
] as const;
export type ExternalSystemId = (typeof EXTERNAL_SYSTEM_IDS)[number];

export const EXTERNAL_CONTRACTS = {
  "llm-providers": {
    owners: [
      {
        path: "apps/api/scripts/ai-provider-cassette-probe.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/mcp-surface-token-calibration.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/record-provider-cassettes.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/replay-provider-events-performer.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/chat-orientation-eval.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/provider-request-schemas.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/chat/openrouter-credential.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/chat/provider-data-policy.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/stella-openrouter-text-adapter.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/tanstack-ai-models.ts",
        role: "primary",
      },
      {
        path: "packages/scripts/src/model-catalog-benchmarks-gen.ts",
        role: "primary",
      },
      {
        path: "packages/scripts/src/model-catalog-snapshot.ts",
        role: "primary",
      },
      {
        path: "packages/scripts/src/model-catalog-upstream.ts",
        role: "primary",
      },
    ],
    sdks: [
      "@tanstack/ai",
      "@tanstack/ai-anthropic",
      "@tanstack/ai-bedrock",
      "@tanstack/ai-gemini",
      "@tanstack/ai-mistral",
      "@tanstack/ai-openai",
      "@tanstack/ai-openrouter",
      "@google/genai",
      "@openrouter/sdk",
      "@anthropic-ai/sdk",
      "@aws-sdk/client-bedrock-runtime",
      "openai",
      "@mistralai/mistralai",
      "@smithy/fetch-http-handler",
    ],
    pinSources: [
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-anthropic",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-bedrock",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-gemini",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-mistral",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-openai",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-openrouter",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@google/genai",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@openrouter/sdk",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "devDependencies",
        package: "@anthropic-ai/sdk",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "devDependencies",
        package: "@aws-sdk/client-bedrock-runtime",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "devDependencies",
        package: "openai",
      },
    ],
    driftTriggers: [
      "pin-bump",
      "provider-request-schemas-check",
      "model-catalog-check",
    ],
    status: "characterised",
    uncharacterisedScope: {
      owners: [
        {
          path: "apps/api/scripts/ai-provider-cassette-probe.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "apps/api/scripts/mcp-surface-token-calibration.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "apps/api/scripts/record-provider-cassettes.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "apps/api/scripts/replay-provider-events-performer.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "apps/api/scripts/chat-orientation-eval.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "apps/api/scripts/provider-request-schemas.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "packages/scripts/src/model-catalog-benchmarks-gen.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "packages/scripts/src/model-catalog-snapshot.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
        {
          path: "packages/scripts/src/model-catalog-upstream.ts",
          reason:
            "The provider wire and request-schema replay files do not import this transport owner.",
        },
      ],
      sdks: [],
    },
    fixtures: [
      {
        path: "apps/api/src/tests/fixtures/provider-wire",
        replayFiles: ["apps/api/src/lib/tanstack-ai-provider-wire.test.ts"],
        metadata: "apps/api/src/tests/fixtures/provider-wire.source.json",
        provenance: {
          type: "sidecars",
          format: "provider-wire",
        },
        replay: "fetch-replay",
      },
      {
        path: "apps/api/src/tests/fixtures/provider-request-schemas",
        replayFiles: ["apps/api/src/lib/tanstack-ai-provider-wire.test.ts"],
        provenance: {
          type: "sidecars",
          format: "provider-request-schemas",
        },
        replay: "schema-validation",
        pinMetadata: "provider-request-schemas",
      },
    ],
  },
  "legal-publishers": {
    owners: [
      {
        path: "apps/api/scripts/capture-parser-fixture.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/record-eu-ecj-fixtures.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/case-law/decisions/dev-reparse.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/cz-us-throttle.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/case-law/judges/import-cz-us-roster.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/soft-law/publisher-access.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/citation-probe.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "characterised",
    uncharacterisedScope: {
      owners: [
        {
          path: "apps/api/scripts/capture-parser-fixture.ts",
          reason:
            "The enrolled captured-fixture replays do not import this publisher transport owner.",
        },
        {
          path: "apps/api/scripts/record-eu-ecj-fixtures.ts",
          reason:
            "The enrolled captured-fixture replays do not import this publisher transport owner.",
        },
        {
          path: "apps/api/src/handlers/case-law/decisions/dev-reparse.ts",
          reason:
            "The enrolled captured-fixture replays do not import this publisher transport owner.",
        },
        {
          path: "apps/api/src/handlers/case-law/ingestion/adapters/cz-us-throttle.ts",
          reason:
            "The enrolled captured-fixture replays do not import this publisher transport owner.",
        },
        {
          path: "apps/api/src/handlers/soft-law/publisher-access.ts",
          reason:
            "The enrolled captured-fixture replays do not import this publisher transport owner.",
        },
        {
          path: "apps/api/src/scripts/citation-probe.ts",
          reason:
            "The enrolled captured-fixture replays do not import this publisher transport owner.",
        },
      ],
      sdks: [],
    },
    fixtures: [
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/__fixtures__",
        replayFiles: [
          "apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.test.ts",
          "apps/api/src/handlers/case-law/ingestion/adapters/sk-us.test.ts",
        ],
        provenance: {
          type: "sidecars",
          format: "fixture-provenance",
        },
        replay: "parser-replay",
        metadata:
          "packages/external-contracts/fixtures/legal-publishers-0.source.json",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/parsers/__fixtures__",
        replayFiles: [
          "apps/api/src/handlers/case-law/ingestion/parsers/eu-ecj.test.ts",
          "apps/api/src/handlers/case-law/ingestion/parsers/at-ris.test.ts",
        ],
        provenance: {
          type: "sidecars",
          format: "fixture-provenance",
        },
        replay: "parser-replay",
        metadata:
          "packages/external-contracts/fixtures/legal-publishers-1.source.json",
      },
      {
        path: "apps/api/src/handlers/case-law/judges/__fixtures__",
        replayFiles: [
          "apps/api/src/handlers/case-law/judges/import-cz-us-roster.test.ts",
        ],
        provenance: {
          type: "sidecars",
          format: "fixture-provenance",
        },
        replay: "parser-replay",
        metadata:
          "packages/external-contracts/fixtures/legal-publishers-2.source.json",
      },
    ],
  },
  "identity-services": {
    owners: [
      {
        path: "apps/api/src/agent-auth/id-jag.ts",
        role: "primary",
      },
      {
        path: "packages/scripts/src/auth-md-spec-drift.ts",
        role: "primary",
      },
      {
        path: "packages/cli/src/auth/loopback-listener.ts",
        role: "primary",
      },
      {
        path: "packages/cli/src/auth/oauth-client-registration.ts",
        role: "primary",
      },
      {
        path: "packages/cli/src/auth/oauth-metadata.ts",
        role: "primary",
      },
      {
        path: "packages/cli/src/auth/token-exchange.ts",
        role: "primary",
      },
    ],
    sdks: ["jose"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "jose",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  "microsoft-graph": {
    owners: [
      {
        path: "apps/api/src/handlers/sharepoint/graph-client.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/sharepoint/graph-oauth.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Refresh and paging unit tests exist; no versioned Graph response corpus is enrolled.",
  },
  "s3-compatible": {
    owners: [
      {
        path: "apps/api/src/lib/email/inbound/ses.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/s3-presign.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/s3.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/entities/zip/download.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/files/get.ts",
        role: "primary",
      },
      {
        path: "packages/mcp-apps/src/document-upload/runtime.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/inspector/file-download-service.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/files/storage-fetch.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/files/upload-entity-version.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/knowledge/queries.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-pdf-download-button.tsx",
        role: "primary",
      },
      {
        path: "packages/cli/src/upload-document.ts",
        role: "primary",
      },
    ],
    sdks: [
      "@aws-sdk/client-s3",
      "@aws-sdk/client-sts",
      "@aws-sdk/s3-request-presigner",
    ],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/client-s3",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/client-sts",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/s3-request-presigner",
      },
      {
        type: "image",
        file: "scripts/ci-service-images.json",
        name: "rustfs",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "characterised",
    uncharacterisedScope: {
      owners: [
        {
          path: "apps/api/src/lib/email/inbound/ses.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/api/src/handlers/entities/zip/download.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/api/src/handlers/files/get.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "packages/mcp-apps/src/document-upload/runtime.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/web/src/components/inspector/file-download-service.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/web/src/lib/files/storage-fetch.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/web/src/lib/files/upload-entity-version.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/web/src/lib/knowledge/queries.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-pdf-download-button.tsx",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
        {
          path: "packages/cli/src/upload-document.ts",
          reason:
            "The S3 fake and presign replays do not import this storage transport owner.",
        },
      ],
      sdks: [],
    },
    fixtures: [
      {
        path: "apps/api/src/tests/helpers/fake-s3.test.ts",
        replayFiles: ["apps/api/src/tests/helpers/fake-s3.test.ts"],
        metadata:
          "packages/external-contracts/fixtures/s3-compatible.source.json",
        provenance: {
          type: "authored",
          kind: "synthetic-from-spec",
        },
        replay: "wire-fake",
      },
      {
        path: "apps/api/src/lib/s3-presign.test.ts",
        replayFiles: ["apps/api/src/lib/s3-presign.test.ts"],
        metadata: "packages/external-contracts/fixtures/s3-rustfs.source.json",
        provenance: {
          type: "authored",
          kind: "synthetic-from-spec",
        },
        replay: "container",
      },
    ],
  },
  "aws-services": {
    owners: [
      {
        path: "apps/api/src/lib/email/inbound/sqs.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/email/ses.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/db/ebs-balance-reader.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/visual-preview.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/inbound-mail-receive.ts",
        role: "primary",
      },
    ],
    sdks: [
      "@aws-sdk/client-cloudwatch",
      "@aws-sdk/client-lambda",
      "@aws-sdk/client-sesv2",
      "@aws-sdk/client-sqs",
    ],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/client-cloudwatch",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/client-lambda",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/client-sesv2",
      },
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@aws-sdk/client-sqs",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  smtp: {
    owners: [
      {
        path: "apps/api/src/lib/email/smtp.ts",
        role: "primary",
      },
    ],
    sdks: ["nodemailer"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "nodemailer",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  deepl: {
    owners: [
      {
        path: "apps/api/src/lib/deepl/client.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  jina: {
    owners: [
      {
        path: "apps/api/src/lib/web-search/jina.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  tavily: {
    owners: [
      {
        path: "apps/api/src/lib/web-search/tavily.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  "system-one": {
    owners: [
      {
        path: "apps/api/src/lib/workflow/decisions/system-one.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  gotenberg: {
    owners: [
      {
        path: "apps/api/src/lib/files/gotenberg.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/health/probe-document-converter.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [
      {
        type: "image",
        file: "scripts/ci-service-images.json",
        name: "gotenberg",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  github: {
    owners: [
      {
        path: "apps/api/src/lib/github/github-write.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/selfhost-update-banner.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/features/knowledge/public/tools/tool-contribute-page.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/public-tools-github-content.ts",
        role: "primary",
      },
    ],
    sdks: ["@changesets/changelog-github"],
    pinSources: [
      {
        type: "manifest",
        file: "package.json",
        section: "devDependencies",
        package: "@changesets/changelog-github",
      },
    ],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "REST unit fixtures exist; no published GraphQL schema or recorded response corpus is enrolled.",
  },
  polar: {
    owners: [
      {
        path: "apps/api/src/lib/hosted-usage-provider/client.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [
      {
        type: "constant",
        file: "apps/api/src/lib/hosted-usage-provider/polar/contract.ts",
        name: "POLAR_API_VERSIONS",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Synthetic webhook and normalization tests exist; recorded delivery shapes are not enrolled.",
  },
  quickwit: {
    owners: [
      {
        path: "apps/api/src/lib/legal-search/corpus-index-client.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [
      {
        type: "image",
        file: "scripts/ci-service-images.json",
        name: "quickwit",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "characterised",
    uncharacterisedScope: {
      owners: [],
      sdks: [],
    },
    fixtures: [
      {
        path: "apps/api/src/lib/legal-search/corpus-index-query-features.contract.test.ts",
        replayFiles: [
          "apps/api/src/lib/legal-search/corpus-index-query-features.contract.test.ts",
        ],
        metadata: "packages/external-contracts/fixtures/quickwit.source.json",
        provenance: {
          type: "authored",
          kind: "synthetic-from-spec",
        },
        replay: "container",
      },
    ],
  },
  otlp: {
    owners: [
      {
        path: "apps/api/src/lib/observability/otel.ts",
        role: "primary",
      },
    ],
    sdks: ["@opentelemetry/exporter-logs-otlp-http", "@opentelemetry/sdk-logs"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "@opentelemetry/exporter-logs-otlp-http",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  "better-auth": {
    owners: [
      {
        path: "apps/api/src/mcp/auth.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/demo-account-policy.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/session-bearer.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/oauth-consent-info.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/review-account-plugin.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/registration-adapter.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/session-lifetime.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/oauth-registration-policy.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/auth/demo-account-hooks.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/user-shortcuts.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/selfhost-auth.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/membership-role-invariants.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/time-entry-offboarding.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/rate-limit/otp-account-budget.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/machine-api-keys/personal-lifecycle.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/better-auth-sign-in-replay.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/auth-client.ts",
        role: "primary",
      },
      {
        path: "packages/permissions/src/index.ts",
        role: "primary",
      },
    ],
    sdks: [
      "better-auth",
      "@better-auth/api-key",
      "@better-auth/cimd",
      "@better-auth/core",
      "@better-auth/oauth-provider",
    ],
    pinSources: [
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "better-auth",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@better-auth/api-key",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@better-auth/cimd",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@better-auth/core",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@better-auth/oauth-provider",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Runtime and sign-in tests exist; a versioned OAuth and session response corpus is not enrolled.",
  },
  "mcp-servers": {
    owners: [
      {
        path: "apps/api/src/lib/mcp-upstream/connections.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/mcp-canary.ts",
        role: "primary",
      },
      {
        path: "packages/cli/src/mcp-client.ts",
        role: "primary",
      },
    ],
    sdks: [
      "@tanstack/ai-mcp",
      "@modelcontextprotocol/sdk",
      "@modelcontextprotocol/client",
    ],
    pinSources: [
      {
        type: "manifest",
        file: "package.json",
        section: "catalog",
        package: "@tanstack/ai-mcp",
      },
      {
        type: "manifest",
        file: "package.json",
        section: "resolutions",
        package: "@modelcontextprotocol/sdk",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  posthog: {
    owners: [
      {
        path: "apps/api/src/lib/analytics/posthog-node.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/analytics/posthog.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/api-request-context.ts",
        role: "primary",
      },
    ],
    sdks: ["posthog-node", "posthog-js"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "posthog-node",
      },
      {
        type: "manifest",
        file: "apps/web/package.json",
        section: "dependencies",
        package: "posthog-js",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  "mail-dns": {
    owners: [
      {
        path: "apps/api/src/lib/email/inbound/authentication.ts",
        role: "primary",
      },
    ],
    sdks: ["mailauth"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "mailauth",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  postgres: {
    owners: [
      {
        path: "apps/api/src/lib/public-law-read-db.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/db/long-running-connection.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/db/migrate.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/db/root.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/db/online-index-observer.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/seed-reset.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/decision-analysis.db.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/better-auth-migration-audit.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/seed-migration-rehearsal.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/better-auth-17-backfill.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/database-census.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/better-auth-microsoft-identity-map.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/health/database-login-probe.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/case-law/maintenance-lane.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [
      {
        type: "image",
        file: "scripts/ci-service-images.json",
        name: "postgres",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "characterised",
    uncharacterisedScope: {
      owners: [
        {
          path: "apps/api/src/lib/public-law-read-db.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/db/long-running-connection.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/db/migrate.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/db/root.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/db/online-index-observer.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/scripts/seed-reset.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/scripts/decision-analysis.db.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/scripts/better-auth-migration-audit.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/scripts/seed-migration-rehearsal.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/scripts/better-auth-17-backfill.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/scripts/database-census.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/scripts/better-auth-microsoft-identity-map.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/lib/health/database-login-probe.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
        {
          path: "apps/api/src/lib/case-law/maintenance-lane.ts",
          reason:
            "The lock-for-write replay does not import this database transport owner.",
        },
      ],
      sdks: [],
    },
    fixtures: [
      {
        path: "apps/api/src/lib/db/lock-for-write.postgres.test.ts",
        replayFiles: ["apps/api/src/lib/db/lock-for-write.postgres.test.ts"],
        metadata: "packages/external-contracts/fixtures/postgres.source.json",
        provenance: {
          type: "authored",
          kind: "synthetic-from-spec",
        },
        replay: "container",
      },
    ],
  },
  valkey: {
    owners: [
      {
        path: "apps/api/src/lib/redis-client.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/scheduler/bullmq.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/bullmq-queue.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/workflow-queue.ts",
        role: "primary",
      },
    ],
    sdks: ["bullmq", "ioredis"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/api/package.json",
        section: "dependencies",
        package: "bullmq",
      },
      {
        type: "image",
        file: "scripts/ci-service-images.json",
        name: "valkey",
      },
      {
        type: "image",
        file: "scripts/ci-service-images.json",
        name: "redis",
      },
    ],
    driftTriggers: ["pin-bump"],
    status: "characterised",
    uncharacterisedScope: {
      owners: [
        {
          path: "apps/api/src/lib/scheduler/bullmq.ts",
          reason:
            "The Redis client-policy replay does not import this queue transport owner.",
        },
        {
          path: "apps/api/src/lib/workflow-queue.ts",
          reason:
            "The Redis client-policy replay does not import this queue transport owner.",
        },
      ],
      sdks: [],
    },
    fixtures: [
      {
        path: "apps/api/src/lib/redis-client-policy.valkey.test.ts",
        replayFiles: ["apps/api/src/lib/redis-client-policy.valkey.test.ts"],
        metadata: "packages/external-contracts/fixtures/valkey.source.json",
        provenance: {
          type: "authored",
          kind: "synthetic-from-spec",
        },
        replay: "container",
      },
    ],
  },
  boe: {
    owners: [
      {
        path: "packages/boe/src/client.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/legal-search/boe-client.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/legislation/boe-error.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/legislation/boe/related-laws/list.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/chat/tools/boe-tools.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/mcp/research-admin-tools.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/legislation/boe/search.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  "business-registries": {
    owners: [
      {
        path: "packages/business-registries/src/shared/http.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/business-registries/dispatch.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/business-registries/entity-checks.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/business-registries/credentials.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/docx/lookup-fields.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/chat/projections.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/contacts/contact-import-receipt.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/desktop-registry/service.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/image-smoke.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/company-registry-preview.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/company-specification.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/search-company-result.logic.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/templates/registry-format-config.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/routes/knowledge/-components/template-wizard.tsx",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  infosoud: {
    owners: [
      {
        path: "packages/infosoud/src/client.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/infosoud/client.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/infosoud/agenda-import.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/infosoud/result.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/workspaces/infosoud-courts.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/workspaces/infosoud-common.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Existing unit coverage has no enrolled versioned external response corpus.",
  },
  "custom-llm-adapters": {
    owners: [
      {
        path: "apps/api/src/lib/tanstack-ai-models.ts",
        role: "shared",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Azure Foundry, Hugging Face and configurable OpenAI endpoints share tanstack-ai-models.ts with the enrolled provider family; they have no wire corpus.",
  },
  "aws-s3": {
    owners: [
      {
        path: "apps/api/src/lib/s3.ts",
        role: "shared",
      },
      {
        path: "apps/api/src/lib/s3-presign.ts",
        role: "shared",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "s3.ts and s3-presign.ts use S3-compatible transports; fake and RustFS coverage does not characterise real AWS S3 semantics.",
  },
  "local-runtime": {
    owners: [
      {
        path: "packages/start-runtime/src/local-module-loader.ts",
        role: "primary",
      },
      {
        path: "packages/start-runtime/src/runtime.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/runtime.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/lib/enumerate-safe-handlers.ts",
        role: "primary",
      },
      {
        path: "apps/api/scripts/record-docx-engine-parity.ts",
        role: "primary",
      },
      {
        path: "packages/scan-engine/src/scan-engine.ts",
        role: "primary",
      },
      {
        path: "packages/scan-engine/src/scan-engine.worker.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/testing/dom-network-guard.ts",
        role: "primary",
      },
      {
        path: "packages/test-kit/src/network.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "These census entries load local modules or package-owned binaries, or refuse test requests; local tests exist, but no remote-service characterisation applies.",
  },
  "stella-api": {
    owners: [
      {
        path: "apps/api/scripts/seed-firm-knowledge.ts",
        role: "primary",
      },
      {
        path: "packages/mcp-apps/src/file-comparison/runtime.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/post-deploy-response-policy.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/scripts/post-deploy-smoke.ts",
        role: "primary",
      },
      {
        path: "apps/collab/src/server.ts",
        role: "primary",
      },
      {
        path: "apps/collab/src/server-test-process.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/boot-prefetch.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/ai-suggestions/document-review-proposal-stream.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/api-version-mismatch-refresh.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/auth/sign-in-panel.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/autocomplete/use-autocomplete-stream.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/chat/message-export-menu.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/routes/dev/-components/autocomplete-playground.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/docx/use-edit-session.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/docx/use-folio-collaboration-room.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/inspector/external-reference-panel.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/inspector/review-export-menu.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/components/pdf/peek/peek-pdf-print.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/workspaces/request-manual-ocr.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/components/workspaces/row-actions.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/features/avt/use-load-sample-case.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/features/chat/chat-fetch.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/features/chat/chat-runtime.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/features/statutes/statute-sitemap.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/dev-otp.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/files/queries.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/public-law-sitemap.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/user-events-sse.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/workspace-sse.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/workspaces/mutations/use-create-file-entities.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/lib/workspaces/time-entries-api.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/routes/_protected.contacts/-procuracao-extraction.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar.tsx",
        role: "primary",
      },
      {
        path: "apps/web/src/routes/agent-claim.tsx",
        role: "primary",
      },
      {
        path: "packages/cli/src/compatibility.ts",
        role: "primary",
      },
      {
        path: "packages/scripts/src/agent-session.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/features/case-law/queries/decision-analysis.ts",
        role: "primary",
      },
      {
        path: "apps/web/src/features/case-law/components/case-viewer/reader-answers-query.ts",
        role: "primary",
      },
    ],
    sdks: ["@hocuspocus/provider", "@hocuspocus/extension-redis"],
    pinSources: [
      {
        type: "manifest",
        file: "apps/web/package.json",
        section: "dependencies",
        package: "@hocuspocus/provider",
      },
      {
        type: "manifest",
        file: "apps/collab/package.json",
        section: "devDependencies",
        package: "@hocuspocus/provider",
      },
      {
        type: "manifest",
        file: "apps/collab/package.json",
        section: "dependencies",
        package: "@hocuspocus/extension-redis",
      },
    ],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Configured API, collaboration WebSocket and Redis pub/sub clients have application tests, with no enrolled release-version response corpus.",
  },
  "http-transport": {
    owners: [
      {
        path: "apps/api/src/lib/errors/tagged-errors.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/lib/safe-outbound-fetch.ts",
        role: "primary",
      },
      {
        path: "packages/fetch/src/index.ts",
        role: "primary",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/adapters/test-utils.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Shared transport and error helpers route callers to registered services; their unit tests do not form a service response corpus.",
  },
  "desktop-bridge": {
    owners: [
      {
        path: "apps/web/src/lib/desktop-bridge.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Loopback bridge tests exist, with no enrolled release-version response corpus.",
  },
  "docker-engine": {
    owners: [
      {
        path: "packages/agent-engine/src/bun-docker/api.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Docker socket requests have unit coverage, with no enrolled engine-version response corpus.",
  },
  "npm-registry": {
    owners: [
      {
        path: "packages/cli/src/cli-release-channel.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Release metadata unit fixtures exist, with no recorded npm registry response corpus.",
  },
  "development-services": {
    owners: [
      {
        path: "packages/scripts/src/dev-runner.ts",
        role: "primary",
      },
    ],
    sdks: [],
    pinSources: [],
    driftTriggers: ["upstream-response-change"],
    status: "uncharacterised",
    reason:
      "Development probes target configured services and local ports; no versioned probe response corpus is enrolled.",
  },
} as const satisfies Record<ExternalSystemId, ExternalContractEntry>;

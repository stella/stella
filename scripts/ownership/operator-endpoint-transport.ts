import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "operator-endpoint-transport",
  capability: "Posting to endpoints the operator configured for the API",
  owner: ["apps/api/src/lib/observability/operator-endpoint-fetch.ts"],
  summary:
    "postToOperatorEndpoint skips the address checks that guard request-selected URLs, because an operator's collector may sit on a private network. Only clients whose URL comes from the API environment may call it; each reads status and headers and releases the body unread.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/observability/operator-endpoint-fetch"],
    names: ["postToOperatorEndpoint"],
    allowed: [
      {
        path: "apps/api/src/lib/analytics/posthog-client.ts",
        reason: "Sends analytics batches to POSTHOG_HOST from the environment.",
      },
      {
        path: "apps/api/src/lib/observability/otlp-log-exporter.ts",
        reason: "Exports log records to LOGS_OTLP_URL from the environment.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

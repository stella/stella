import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "redis-client",
  capability: "Valkey/Redis connections for ephemeral coordination",
  owner: ["apps/api/src/lib/redis-client.ts"],
  summary:
    "The API factory requires a storage class for every client and owns the " +
    "reconnect ladder, error classification, and connection options. " +
    "Shared policy inspection covers durable coordination; the construction " +
    "guard checks both the API and collaboration factories. " +
    "Valkey may carry only ephemeral coordination, and each allowed consumer " +
    "states the degraded path it takes during an outage.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/redis-client"],
    allowed: [
      {
        path: "apps/api/src/lib/case-law/analysis-failure.ts",
        reason:
          "TTL-bounded delivery of organization-scoped background analysis failures; outage returns an explicit captured error.",
      },
      {
        path: "apps/api/src/lib/admission-redis.ts",
        reason:
          "Admission clients check and periodically refresh the non-eviction policy before issuing coordination commands.",
      },
      {
        path: "apps/api/src/lib/bullmq-queue.ts",
        reason:
          "Queue transport. The shared facade owns lazy producer connections; BullMQ owns the key layout under its own prefix.",
      },
      {
        path: "apps/api/src/lib/document-deadline-scout-worker.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/document-processing-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/workflow-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/file-derivative-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/entity-deletion-cleanup-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/account-deletion-cleanup-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/style-set-package-cleanup-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/email/inbound/upload-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/document-review/run-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/lists/verification/run-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/bilingual/run-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/document-translation/run-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/flows/flow-run-worker.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/scheduler/bullmq.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/handlers/reports/report-export-queue.ts",
        reason:
          "Queue transport: worker owns its dedicated blocking connection.",
      },
      {
        path: "apps/api/src/lib/sse-broadcast.ts",
        reason:
          "Cross-instance SSE fan-out publisher. Lost messages degrade to inline local delivery.",
      },
      {
        path: "apps/api/src/lib/sse.ts",
        reason:
          "Cross-instance SSE fan-out subscriber. Lost messages degrade to inline local delivery.",
      },
      {
        path: "apps/api/src/lib/rate-limit/redis-context.ts",
        reason:
          "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
      },
      {
        path: "apps/api/src/lib/rate-limit/auth-storage.ts",
        reason:
          "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
      },
      {
        path: "apps/api/src/mcp/gateway/rate-limit.ts",
        reason:
          "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
      },
      {
        path: "apps/api/src/handlers/feedback/intake-guards.ts",
        reason:
          "TTL'd rate-limit counters; degrades to a per-process fallback map when Valkey is unreachable.",
      },
      {
        path: "apps/api/src/lib/security-canary.ts",
        reason:
          "TTL'd alert deduplication; an outage emits the alert rather than suppressing it.",
      },
      {
        path: "apps/api/src/lib/document-processing-readiness.ts",
        reason: "TTL'd OCR worker readiness lease; absence reads as unready.",
      },
      {
        path: "apps/api/src/lib/workflow/root-run-state-store.ts",
        reason:
          "Workflow run locks and progress counters, rebuilt from the durable orphan reconciler when they are lost.",
      },
      {
        path: "apps/api/src/lib/health/readiness.ts",
        reason: "Liveness probe: PINGs the connection it is reporting on.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

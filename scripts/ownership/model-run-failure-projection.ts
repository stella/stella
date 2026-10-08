import type { OwnershipEntry } from "../ownership-types.ts";
// The engine's raw run forms. Their failures carry provider and model text, so
// only the modules that project them to fixed-message errors call them.
const RAW_MODEL_RUN_NAMES = [
  "generateChatObject",
  "streamChatChunks",
  "streamChatObject",
] as const;

export default {
  id: "model-run-failure-projection",
  capability: "Running a model through the engine's raw run forms",
  owner: ["apps/api/src/lib/tanstack-ai-generate.ts"],
  summary:
    "A failed run's `RUN_ERROR` message and code, and the errors the engine " +
    "throws, carry provider bodies and model output. The owner turns every " +
    "failure into a `ProviderCallError` or `ModelRunError` with a fixed " +
    "message (`withRecoveredProviderStatus`), and hands a caller that " +
    "consumes chunks itself `streamTanStackChatRun`, whose `RUN_ERROR` " +
    "carries only that message and the classified kind. A caller that " +
    "assembles its own options uses `streamTanStackChatRun`, " +
    "`collectTanStackTextRun` or `generateTanStackChatObject`.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/chat/tanstack-chat-runtime"],
    names: RAW_MODEL_RUN_NAMES,
    allowed: [
      {
        path: "apps/api/src/handlers/chat/stream-chat.ts",
        reason:
          "The chat turn projects each `RUN_ERROR` through `normalizeRunErrorChunk` before it is streamed or stored.",
      },
      {
        path: "apps/api/evals/",
        reason:
          "Offline evaluations: a run failure is reported to the operator and never stored.",
      },
      {
        path: "apps/api/scripts/ai-provider-canary.ts",
        reason:
          "Provider canary: reads the raw run error to report the provider's answer to the operator.",
      },
      {
        path: "apps/api/scripts/benchmark-chat-read-surface.ts",
        reason: "Benchmark with synthetic content; nothing is stored.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "chat-ref-registry",
  capability: "Creating chat ref registries for a turn or saved transcript",
  owner: ["apps/api/src/handlers/chat/send-message.ts"],
  summary:
    "A ref such as `ent_1` keeps its target within its chat thread. " +
    "The send owns minting new refs; readers of saved transcripts rebuild " +
    "the registry from persisted bindings to resolve or neutralize those " +
    "refs. Other code returns ids and resolved links instead.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/chat/ref-registry"],
    names: ["createChatRefRegistry"],
    allowed: [
      {
        path: "apps/api/scripts/ai-provider-canary-chat-toolsets.ts",
        reason:
          "Builds one chat request's toolsets offline to project their schemas for each provider; the registry never leaves that build.",
      },
      {
        path: "apps/api/src/handlers/chat/tools/chat-history-tools.ts",
        reason:
          "Rebuilds persisted bindings when expanding saved messages so refs from another turn are rebound or neutralized.",
      },
      {
        path: "apps/api/src/handlers/chat/skill-availability/offered-tools.ts",
        reason:
          "Builds a new chat's tool set only to read its tool names for skill availability; no tool runs and the registry never leaves that build.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/memory-extractor.ts",
        reason:
          "Rebuilds persisted bindings to turn saved transcript refs into durable links before storing memories.",
      },
      {
        path: "apps/api/evals/playbook-authoring.ts",
        reason:
          "Replays each scripted chat request against the live tools and mints that request's registry, as send-message does; refs never outlive the replayed request.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

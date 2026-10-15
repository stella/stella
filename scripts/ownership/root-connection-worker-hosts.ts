import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "root-connection-worker-hosts",
  capability:
    "Handing the owner connection to the queue workers a process hosts",
  owner: [
    "apps/api/src/api-background-workers.ts",
    "apps/api/src/scripts/document-processing-worker.ts",
  ],
  summary:
    "Each process that runs BullMQ workers builds its host here and passes the " +
    "owner connection into every worker it starts (`BullMqWorkerContext.db`). " +
    "Workers take that handle as a required dependency and hand it to their " +
    "collaborators; none of them imports the connection itself.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;

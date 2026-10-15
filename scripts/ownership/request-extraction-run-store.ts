import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "request-extraction-run-store",
  capability: "Recording the extraction run a request starts",
  owner: ["apps/api/src/lib/extraction-runs/request-run-store.ts"],
  summary:
    "`extraction_runs` admits no tenant writes, so a request that starts a " +
    "workflow records its run on the owner connection. The door exposes only " +
    "the transitions a starter performs before a worker holds the run " +
    "(create, start, skip, fail); workers pass the store their host built.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/extraction-runs/request-run-store"],
    allowed: [
      {
        path: "apps/api/src/handlers/playbooks/applicable/run.ts",
        reason: "Starts the workflow for the applicable playbooks it opened.",
      },
      {
        path: "apps/api/src/handlers/playbooks/run.ts",
        reason: "Starts the workflow for the playbook run it opened.",
      },
      {
        path: "apps/api/src/handlers/workspaces/cells/retry.ts",
        reason: "Starts the workflow that re-runs one cell.",
      },
      {
        path: "apps/api/src/handlers/workspaces/workflow/start.ts",
        reason: "Starts the workflow a caller asked for.",
      },
      {
        path: "apps/api/src/mcp/knowledge-tools.ts",
        reason: "Starts the workflow an agent tool asked for.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

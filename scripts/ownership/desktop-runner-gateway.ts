import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "desktop-runner-gateway",
  capability: "Serving desktop runner sockets and queuing their run commands",
  owner: ["apps/api/src/lib/desktop-runner/runtime.ts"],
  summary:
    "The gateway authenticates each runner socket with the desktop account token and a single-use device proof, binds it to account, organization, installation and device key, and speaks the runner protocol over it. " +
    "Postgres holds runner sessions, run assignments with leases, queued commands and the acknowledged event log; a doorbell nudges the task holding a socket and a sweep catches lost nudges. " +
    "The control half picks a computer, queues commands and reads a run's events for the rest of the API.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/desktop-runner/runtime"],
    allowed: [
      {
        path: "apps/api/src/server.ts",
        reason: "Starts the gateway at boot and drains it on shutdown.",
      },
      {
        path: "apps/api/src/handlers/desktop-runner/connect.ts",
        reason: "Hands the upgrade request to the gateway.",
      },
      {
        path: "apps/api/src/handlers/chat/local-run-plan.ts",
        reason:
          "Routes a chat turn bound for the member's computer through the control and reads its run back.",
      },
      {
        path: "apps/api/src/mcp/agent-run-app-calls.ts",
        reason:
          "Keeps what the MCP server answered a run's token for a tool a chat app presents, so the chat turn can pair the run's reported calls with it.",
      },
      {
        path: "apps/api/src/handlers/chat/local-runners.ts",
        reason:
          "Reads the member's computers and harness reports for the chat composer.",
      },
      {
        path: "apps/api/src/handlers/chat/local-folder-approval.ts",
        reason:
          "Records the member's OK for turns to work in a folder linked on one of their computers.",
      },
      {
        path: "apps/api/src/handlers/chat/turns/local-files-undo.ts",
        reason:
          "Asks the turn's computer to undo the turn's file changes and reads where that undo stands.",
      },
      {
        path: "apps/api/src/handlers/chat/threads/background-tasks.ts",
        reason:
          "Reads what a chat's runs left running in the background on the member's computers.",
      },
      {
        path: "apps/api/src/handlers/chat/local-run-step-output-grant.ts",
        reason:
          "Reads the member's own run to grant reading its step outputs on the computer that ran it.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

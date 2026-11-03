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
    ],
  },
} as const satisfies OwnershipEntry;

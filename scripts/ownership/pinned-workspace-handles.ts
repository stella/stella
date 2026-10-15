import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "pinned-workspace-handles",
  capability: "Database handles pinned to stored workspace ids",
  owner: ["apps/api/src/lib/root-scoped-db.ts"],
  summary:
    "A pinned handle reaches the workspaces it names whether or not its user " +
    "is still a member of them, so it is built only for writes and lookups an " +
    "earlier check already proved. A run a member queued goes through " +
    "`createRootRunActor` instead, whose pinned `writeDb` the document, file " +
    "and field readers (`ContentReadDb`) refuse. " +
    "`createRootOrganizationBackgroundDb` validates the organization id and " +
    "binds background work to that organization with no user or stored workspace ids.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/root-scoped-db"],
    names: ["createRootScopedDb", "createRootSafeDb"],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/research/answers-run.ts",
        reason:
          "A research run that outlives its request, pinned to no workspace.",
      },
      {
        path: "apps/api/src/handlers/uploads/entity-version.ts",
        reason: "Computes diff stats for the version the upload just wrote.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/link-grants.ts",
        reason: "Scopes a claimed desktop connection to its stored grant.",
      },
      {
        path: "apps/api/src/lib/desktop-edit-sessions.ts",
        reason: "Writes back through a live desktop editing session.",
      },
      {
        path: "apps/api/src/lib/email/inbound/runtime.ts",
        reason: "Files inbound mail into the matter its routing resolved.",
      },
      {
        path: "apps/api/src/lib/email/inbound/upload.ts",
        reason:
          "Files an email file as its uploader, whose matter access the filing transaction rechecks.",
      },
      {
        path: "apps/api/src/lib/entity-versions/create-entity-version-from-buffer.ts",
        reason: "Writes a new version into a workspace its caller proved.",
      },
      {
        path: "apps/api/src/lib/file-derivative-queue.ts",
        reason: "Derivative generation is organization automation.",
      },
      {
        path: "apps/api/src/lib/files/pdf-signing/sessions.ts",
        reason: "Scopes a signing session to its stored workspace.",
      },
      {
        path: "apps/api/src/lib/flows/flow-executor.ts",
        reason:
          "Flow steps, a member run not yet on the run actor (scripts/queue-authority-baseline.json).",
      },
      {
        path: "apps/api/src/lib/folio-collab-rooms.ts",
        reason: "Persists a collaboration room re-checked on every token use.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/work-attention-scout.ts",
        reason: "Scheduled organization automation.",
      },
      {
        path: "apps/api/src/lib/scouts/document-deadlines.ts",
        reason: "Scheduled organization automation.",
      },
      {
        path: "apps/api/src/lib/scouts/work-attention.ts",
        reason: "Takes the constructor as an injected dependency type.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

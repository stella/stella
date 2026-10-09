import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "task-assignment-membership",
  capability: "Writing task assignments for current matter members",
  owner: [
    "apps/api/src/lib/tasks/assignment-membership.ts",
    "apps/api/src/lib/member-assignment-offboarding-owner.ts",
    "apps/api/src/lib/account-deletion-steps.ts",
  ],
  summary:
    "Assignment writes validate held memberships in their write transaction. Removal clears assignments with former-assignee audit, preserving the task. Matter locks precede workflow run, step, obligation and entity locks; organization offboarding takes its organization membership before the matter prefix.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/db/schema",
      "@/api/db/schema/entities",
      "apps/api/src/db/schema/entities.ts",
    ],
    names: ["taskAssignees"],
    allowed: [
      {
        path: "apps/api/src/lib/member-assignment-offboarding-census.ts",
        reason:
          "Static column metadata used only by the cleanup coverage test; no presence or assignment query.",
      },
      {
        path: "apps/api/src/db/",
        reason: "Schema and relation declarations.",
      },
      {
        path: "apps/api/src/lib/entities/query-entities.ts",
        reason: "Read assignment projection.",
      },
      {
        path: "apps/api/src/lib/tasks/assigned.ts",
        reason: "Read assignment filters.",
      },
      {
        path: "apps/api/src/lib/work-obligations/legacy-work-obligation.ts",
        reason: "Read legacy ownership projection.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/work-obligation-backfill.ts",
        reason: "Read assignment source for obligation backfill.",
      },
      {
        path: "apps/api/src/mcp/matter-tools.ts",
        reason: "Read task detail projection.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

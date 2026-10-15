import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "member-authorization",
  capability: "Deciding what a request's member role and credential may do",
  owner: [
    "apps/api/src/lib/permission-authorization.ts",
    "apps/web/src/lib/organization/role-assignment.logic.ts",
  ],
  summary:
    "Every permission decision reads the request's `AuthorizedMemberRole`: " +
    "the member role together with the credential behind the request. A " +
    "person's session spends the role; a credential minted with a narrower " +
    "permission set spends only what both grant. `hasMemberPermission` and " +
    "`hasManagementPermission` are the reads, and every handler context " +
    "builder sets the credential once, so no handler-level check can fall " +
    "back to the role's full authority. Reading the role table directly " +
    "skips the credential. The web organization role-policy owner derives " +
    "session UI visibility and assignable roles from the shared role policy; " +
    "API decisions still enforce the request credential.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/permissions"],
    names: ["roles", "isOrganizationManagementRole"],
    allowed: [
      {
        path: "apps/api/src/lib/member-roles.ts",
        reason:
          "Recognizes the role names the table defines; it decides no permission.",
      },
      {
        path: "apps/api/src/lib/auth.ts",
        reason:
          "Configures the authentication library's organization roles from the same table.",
      },
      {
        path: "apps/web/src/lib/auth-client.ts",
        reason:
          "Configures the web authentication client's organization roles from the same table.",
      },
      {
        path: "packages/scripts/src/agent-session.ts",
        reason:
          "Local development tooling seeds an owner's key with the owner's full statement set.",
      },
      {
        path: "apps/api/src/mcp/billing-tools.ts",
        reason:
          "`isVisibleToMemberRole` decides which tools are listed; each tool checks the request's effective authority when called.",
      },
      {
        path: "apps/api/src/handlers/entities/join-folio-collab-room.ts",
        reason:
          "Re-checks the person's current membership role, read from the database, when a room is joined.",
      },
      {
        path: "apps/api/src/lib/folio-collab-rooms.ts",
        reason:
          "Re-checks the person's current membership role, read from the database, when a room token is used.",
      },
      {
        path: "apps/api/src/lib/entities/workspace-entity-write-access.ts",
        reason:
          "Re-checks the person's current membership role, read from the database, when a desktop or signing session is used.",
      },
    ],
  },
} as const satisfies OwnershipEntry;

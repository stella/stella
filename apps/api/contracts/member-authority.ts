import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  hasManagementPermission,
  hasMemberPermission,
  roleForDisplay,
} from "@/api/lib/permission-authorization";

declare const memberRole: AuthorizedMemberRole;

// @ts-expect-error the authority's role is private to its owner
void (memberRole.role === "admin");
// @ts-expect-error the authority's role is private to its owner
["admin", "owner"].includes(memberRole.role);
// @ts-expect-error authority must be constructed by its owner
({
  role: "admin",
  credential: { type: "session" },
}) satisfies AuthorizedMemberRole;

hasMemberPermission(memberRole, { entity: ["update"] });
hasManagementPermission(memberRole, { workspace: ["update"] });
roleForDisplay(memberRole) satisfies string;

// @ts-expect-error spreading an authority cannot construct its private state
({ ...memberRole }) satisfies AuthorizedMemberRole;

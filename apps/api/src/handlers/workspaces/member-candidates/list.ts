import { panic, Result } from "better-result";
import { and, asc, eq, isNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readBounded } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "List the people of the caller's organization a matter can be shared " +
    "with, each with their user id, name, email and image, ordered by name. " +
    "Pass a userId to matters.create's memberUserIds or to " +
    "matters.members.add.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "organization_management",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

/**
 * `GET /v1/workspaces/member-candidates`: the organization's members, the
 * people a new or existing matter can be given to. Deleted accounts are left
 * out, as a matter cannot be shared with them.
 */
const listWorkspaceMemberCandidates = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const members = yield* Result.await(
      safeDb(async (tx) => {
        // The organization's membership limit bounds the list; one page
        // keeps a picker's whole choice in one answer.
        const read = await readBounded(
          tx
            .select({
              userId: member.userId,
              name: user.name,
              email: user.email,
              image: user.image,
            })
            .from(member)
            .innerJoin(user, eq(user.id, member.userId))
            .where(
              and(
                eq(member.organizationId, session.activeOrganizationId),
                isNull(user.deletedAt),
              ),
            )
            .orderBy(asc(user.name), asc(member.userId)),
          LIMITS.organizationMembersCount,
        );
        if (read.type === "overflow") {
          return panic("Organization members exceed the membership limit");
        }
        return read.rows;
      }),
    );

    return Result.ok({ members });
  },
);

export default listWorkspaceMemberCandidates;

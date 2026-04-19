import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: {
    workspace: ["read"],
  },
} satisfies HandlerConfig;

const readActiveWorkspace = createSafeRootHandler(
  config,
  async function* ({ safeDb, user, session }) {
    const result = yield* Result.await(
      safeDb((tx) =>
        tx.query.member.findFirst({
          where: {
            userId: user.id,
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            lastActiveWorkspaceId: true,
          },
        }),
      ),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Member not found" }),
      );
    }

    return Result.ok({
      lastActiveWorkspaceId: result.lastActiveWorkspaceId,
    });
  },
);

export default readActiveWorkspace;

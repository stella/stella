import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { matterInboundAddresses } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description: "Read the active inbound address for a matter.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "provider_secret" },
  access: "read",
} satisfies WorkspaceHandlerConfig;

const getMatterInboundAddress = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    const domain = env.INBOUND_MAIL_DOMAIN;
    const [row] =
      domain === undefined
        ? []
        : yield* Result.await(
            safeDb(
              async (tx) =>
                await tx
                  .select({ token: matterInboundAddresses.token })
                  .from(matterInboundAddresses)
                  .where(
                    and(
                      eq(matterInboundAddresses.workspaceId, workspaceId),
                      isNull(matterInboundAddresses.revokedAt),
                    ),
                  )
                  .limit(1),
            ),
          );
    return Result.ok({
      address: row === undefined ? null : `${row.token}@${domain}`,
      setupHint:
        domain === undefined ? "Inbound mail domain is not configured" : null,
    });
  },
);

export default getMatterInboundAddress;

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
    if (env.INBOUND_MAIL_DOMAIN === undefined)
      return Result.ok({
        address: null,
        setupHint: "Inbound mail domain is not configured",
      });
    const [row] = yield* Result.await(
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
      address:
        row === undefined ? null : `${row.token}@${env.INBOUND_MAIL_DOMAIN}`,
    });
  },
);

export default getMatterInboundAddress;

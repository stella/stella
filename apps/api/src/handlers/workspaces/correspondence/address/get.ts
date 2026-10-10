import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { matterInboundAddresses } from "@/api/db/schema";
import { env } from "@/api/env";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type InboundAddressRow = typeof matterInboundAddresses.$inferSelect;

const INBOUND_ADDRESS_COLUMNS = {
  token: matterInboundAddresses.token,
};

const UNPROJECTED_INBOUND_ADDRESS_COLUMNS = [
  "id", // The response exposes the usable address, not its storage identifier.
  "organizationId", // The authorized route determines the organization.
  "workspaceId", // The authorized route already identifies the matter.
  "createdBy", // Address rotation attribution belongs to the audit log.
  "createdAt", // The response only reports the current usable address.
  "revokedAt", // The query excludes revoked addresses.
  "revokedBy", // Revocation attribution belongs to the audit log.
] as const satisfies readonly (keyof InboundAddressRow)[];

type MissingInboundAddressRowColumn = UnprojectedColumns<
  InboundAddressRow,
  typeof INBOUND_ADDRESS_COLUMNS,
  (typeof UNPROJECTED_INBOUND_ADDRESS_COLUMNS)[number]
>;
type UnexpectedInboundAddressRowColumn = UnbackedProjectionKeys<
  InboundAddressRow,
  typeof INBOUND_ADDRESS_COLUMNS,
  (typeof UNPROJECTED_INBOUND_ADDRESS_COLUMNS)[number]
>;
true satisfies MissingInboundAddressRowColumn extends never ? true : never;
true satisfies UnexpectedInboundAddressRowColumn extends never ? true : never;

const config = {
  description: "Read the active inbound address for a matter.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
                  .select(INBOUND_ADDRESS_COLUMNS)
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
        row === undefined || domain === undefined
          ? null
          : `${row.token}@${domain}`,
      setupHint:
        domain === undefined ? "Inbound mail domain is not configured" : null,
    });
  },
);

export default getMatterInboundAddress;

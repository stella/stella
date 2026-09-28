import { Result } from "better-result";

import { sellerProfileParams } from "@/api/handlers/seller-profiles/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Read one active issuer profile in the active organization.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  params: sellerProfileParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.sellerProfiles.findFirst({
          where: {
            id: { eq: params.sellerProfileId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        }),
      ),
    );
    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Seller profile not found" }),
      );
    }
    return Result.ok(row);
  },
);

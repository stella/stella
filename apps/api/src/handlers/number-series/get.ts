import { Result } from "better-result";

import { numberSeriesParams } from "@/api/handlers/number-series/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description: "Read one active document number series.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  access: "read",
  params: numberSeriesParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.numberSeries.findFirst({
          columns: {
            id: true,
            documentType: true,
            name: true,
            pattern: true,
            padding: true,
            sellerProfileId: true,
            isDefault: true,
            createdAt: true,
            updatedAt: true,
          },
          where: {
            id: { eq: params.numberSeriesId },
            organizationId: { eq: session.activeOrganizationId },
            archivedAt: { isNull: true },
          },
        }),
      ),
    );
    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Number series not found" }),
      );
    }
    return Result.ok(row);
  },
);

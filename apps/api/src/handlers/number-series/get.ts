import { Result } from "better-result";

import type { numberSeries } from "@/api/db/schema";
import { numberSeriesParams } from "@/api/handlers/number-series/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type NumberSeriesRow = typeof numberSeries.$inferSelect;

const UNPROJECTED_NUMBER_SERIES_COLUMNS = [
  // Tenant scope is fixed by the active organization and archived rows are excluded.
  "organizationId",
  "archivedAt",
] as const satisfies readonly (keyof NumberSeriesRow)[];

const NUMBER_SERIES_GET_COLUMNS = {
  id: true,
  documentType: true,
  name: true,
  pattern: true,
  padding: true,
  sellerProfileId: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

type MissingNumberSeriesGetColumn = UnprojectedColumns<
  NumberSeriesRow,
  typeof NUMBER_SERIES_GET_COLUMNS,
  (typeof UNPROJECTED_NUMBER_SERIES_COLUMNS)[number]
>;
type UnexpectedNumberSeriesGetColumn = UnbackedProjectionKeys<
  NumberSeriesRow,
  typeof NUMBER_SERIES_GET_COLUMNS,
  (typeof UNPROJECTED_NUMBER_SERIES_COLUMNS)[number]
>;

true satisfies MissingNumberSeriesGetColumn extends never ? true : never;
true satisfies UnexpectedNumberSeriesGetColumn extends never ? true : never;

const config = {
  description: "Read one active document number series.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
  params: numberSeriesParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.numberSeries.findFirst({
          columns: NUMBER_SERIES_GET_COLUMNS,
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

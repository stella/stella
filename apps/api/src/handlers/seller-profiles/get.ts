import { Result } from "better-result";

import type { sellerProfiles } from "@/api/db/schema";
import { sellerProfileParams } from "@/api/handlers/seller-profiles/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type SellerProfileRow = typeof sellerProfiles.$inferSelect;

const UNPROJECTED_SELLER_PROFILE_COLUMNS = [
  // Tenant scope is fixed by the active organization and archived rows are excluded.
  "organizationId",
  "archivedAt",
] as const satisfies readonly (keyof SellerProfileRow)[];

const SELLER_PROFILE_GET_COLUMNS = {
  id: true,
  legalName: true,
  registrationId: true,
  vatId: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  postalCode: true,
  country: true,
  iban: true,
  bic: true,
  accountNumber: true,
  defaultCurrency: true,
  footerNotes: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

type MissingSellerProfileGetColumn = UnprojectedColumns<
  SellerProfileRow,
  typeof SELLER_PROFILE_GET_COLUMNS,
  (typeof UNPROJECTED_SELLER_PROFILE_COLUMNS)[number]
>;
type UnexpectedSellerProfileGetColumn = UnbackedProjectionKeys<
  SellerProfileRow,
  typeof SELLER_PROFILE_GET_COLUMNS,
  (typeof UNPROJECTED_SELLER_PROFILE_COLUMNS)[number]
>;

true satisfies MissingSellerProfileGetColumn extends never ? true : never;
true satisfies UnexpectedSellerProfileGetColumn extends never ? true : never;

const config = {
  description: "Read one active issuer profile in the active organization.",
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
  params: sellerProfileParams,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.sellerProfiles.findFirst({
          columns: SELLER_PROFILE_GET_COLUMNS,
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

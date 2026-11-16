import { eq } from "drizzle-orm";

import { sellerProfiles } from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Seeds the organization's default seller profile, which issuing an invoice
 * requires. Its country has no VAT currency of its own, so it adds no
 * exchange-rate or exemption rule to the invoices a test issues.
 */
export const seedIssuingSeller = async (
  db: TestDatabase,
  organizationId: SafeId<"organization">,
): Promise<SafeId<"sellerProfile">> => {
  const id = createSafeId<"sellerProfile">();
  await db.insert(sellerProfiles).values({
    id,
    organizationId,
    legalName: "Kanzlei Rhein",
    country: "DE",
    defaultCurrency: "USD",
    isDefault: true,
  });
  return id;
};

/** Removes a seller seeded by {@link seedIssuingSeller}, once its invoices are gone. */
export const removeIssuingSeller = async (
  db: TestDatabase,
  id: SafeId<"sellerProfile">,
): Promise<void> => {
  await db.delete(sellerProfiles).where(eq(sellerProfiles.id, id));
};

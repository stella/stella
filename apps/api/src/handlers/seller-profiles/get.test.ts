import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";

import getSellerProfile from "./get";

type GetContext = Parameters<typeof getSellerProfile.handler>[0];

const organizationId = toSafeId<"organization">("org_test");
const profileId = toSafeId<"sellerProfile">("seller_profile_other_org");

describe("seller profile reads", () => {
  test("returns 404 when the profile does not belong to the active organization", async () => {
    let where: unknown;
    const safeDb = asTestRaw<SafeDb>(
      async <T>(operation: (tx: Transaction) => Promise<T>) =>
        Result.ok(
          await operation(
            asTestRaw<Transaction>({
              query: {
                sellerProfiles: {
                  findFirst: async (options: { where: unknown }) => {
                    where = options.where;
                    return undefined;
                  },
                },
              },
            }),
          ),
        ),
    );
    const context = withTimeBillingEnrolment(
      asTestRaw<GetContext>({
        params: { sellerProfileId: profileId },
        request: new Request(
          `https://example.test/v1/seller-profiles/${profileId}`,
        ),
        route: "/v1/seller-profiles/:sellerProfileId",
        safeDb,
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("owner"),
        user: { id: toSafeId<"user">("user_test") },
        recordAuditEvent: async () => {},
      }),
    );

    const result = await getSellerProfile.handler(context);

    expect(result).toEqual({
      code: 404,
      response: { message: "Seller profile not found" },
    });
    expect(where).toEqual({
      id: { eq: profileId },
      organizationId: { eq: organizationId },
      archivedAt: { isNull: true },
    });
  });
});

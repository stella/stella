import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { chatBrowserSiteGrants } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import listBrowserSiteGrants from "@/api/handlers/chat/browser-site-grants/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** The member's own website approvals: the list, the same at every size. */
export const BROWSER_SITE_GRANTS_PAGE = 5;

type SeedOptions = {
  organizationId: SafeId<"organization">;
  otherUserId: SafeId<"user">;
  userId: SafeId<"user">;
  /** A colleague's website approvals, which the read must not walk. */
  size: number;
};

const siteOrigin = (prefix: string, index: number) =>
  `https://${prefix}-${String(index).padStart(4, "0")}.example.com`;

/**
 * Seeds the member's five website approvals beside `size` approvals of a
 * colleague in the same organization, so the population the read must not
 * walk grows while the member's list stays five rows long.
 */
export const seedBrowserSiteGrantsScaling = async (
  database: TestDatabase,
  { organizationId, otherUserId, userId, size }: SeedOptions,
) => {
  const rows = [
    ...Array.from({ length: BROWSER_SITE_GRANTS_PAGE }, (_, index) => ({
      id: createSafeId<"chatBrowserSiteGrant">(),
      organizationId,
      origin: siteOrigin("member", index),
      userId,
    })),
    ...Array.from({ length: size }, (_, index) => ({
      id: createSafeId<"chatBrowserSiteGrant">(),
      organizationId,
      origin: siteOrigin("colleague", index),
      userId: otherUserId,
    })),
  ];
  await database.insert(chatBrowserSiteGrants).values(rows);
  const grantIds = rows.map(({ id }) => id);
  return {
    cleanup: async () => {
      await database
        .delete(chatBrowserSiteGrants)
        .where(inArray(chatBrowserSiteGrants.id, grantIds));
    },
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
  };
};

type BrowserSiteGrantsFixture = Awaited<
  ReturnType<typeof seedBrowserSiteGrantsScaling>
>;

export const browserSiteGrantsScalingScenario = {
  name: "chat browser site grants",
  definition: listBrowserSiteGrants,
  measure: async (fixture: BrowserSiteGrantsFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listBrowserSiteGrants.handler(
        asTestRaw<Parameters<typeof listBrowserSiteGrants.handler>[0]>({
          query: {},
          request: new Request(
            "https://example.test/v1/chat/browser-site-grants",
          ),
          route: "/v1/chat/browser-site-grants",
          safeDb: createSafeDb(
            fixture.database,
            [],
            fixture.organizationId,
            fixture.userId,
          ),
          session: { activeOrganizationId: fixture.organizationId },
          user: { id: fixture.userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (response instanceof HttpStatusResponse || !("grants" in response)) {
        return panic(
          "Browser site grant scaling requires a successful response",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.grants.length,
      };
    }),
};

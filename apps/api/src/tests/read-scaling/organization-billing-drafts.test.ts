import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { featureEnrolments } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import readBillingDraftConfiguration from "@/api/handlers/organization-settings/billing-drafts/get";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { executeRowsSafeDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });

// timeout: PGlite restores the real schema snapshot before checking handler admission.
test("billing configuration reads require the actor's current database enrollment", async () => {
  const db = await getTestDb();
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const safeDb = executeRowsSafeDb(
    createSafeDb(db, [], organizationId, userId),
  );
  const read = async () =>
    await readBillingDraftConfiguration.handler(
      asTestRaw<Parameters<typeof readBillingDraftConfiguration.handler>[0]>({
        safeDb,
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
        memberRole: sessionMemberRole("owner"),
        query: {},
        request: new Request(
          "https://example.test/v1/organization-settings/billing-drafts",
        ),
        route:
          "/v1/organization-settings/billing-drafts" satisfies ApiRoutePath,
      }),
    );
  try {
    testState.setConfig("FEATURE_TIME_BILLING", true);
    await db.insert(organization).values({
      id: organizationId,
      name: "Billing admission fixture",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(user).values({
      id: userId,
      name: "Billing administrator",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    expect(await read()).toMatchObject({ code: 404 });
    await db.insert(featureEnrolments).values({
      organizationId,
      userId,
      featureId: "time-billing",
    });
    expect(await read()).toMatchObject({
      mode: "disabled",
      timeBillingFormat: "categories",
      files: [],
    });
    await db
      .delete(featureEnrolments)
      .where(
        and(
          eq(featureEnrolments.organizationId, organizationId),
          eq(featureEnrolments.userId, userId),
          eq(featureEnrolments.featureId, "time-billing"),
        ),
      );
    expect(await read()).toMatchObject({ code: 404 });
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
    await releaseTestDb();
  }
}, 120_000);

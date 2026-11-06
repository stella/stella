import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import updateOrganizationSlug from "@/api/handlers/organizations/slug/update";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/** Both the global slug population and the active organization's membership grow. */
const seedOrganizationSlugScaling = async (db: GatedTestDb, size: number) => {
  const organizations = Array.from({ length: size }, () => {
    const id = mintAuthProviderId<"organization">();
    return {
      id,
      name: "Slug scaling organization",
      slug: `org-${id.toLowerCase()}`,
      createdAt: new Date(),
    };
  });
  const users = Array.from({ length: size }, () => {
    const id = mintAuthProviderId<"user">();
    return {
      id,
      name: "Slug scaling member",
      email: `${id}@example.test`,
      emailVerified: true,
    };
  });
  const target =
    organizations.at(0) ?? panic("Slug scaling needs an organization");
  const actor = users.at(0) ?? panic("Slug scaling needs an actor");
  await db.insert(organization).values(organizations);
  await db.insert(user).values(users);
  await db.insert(organizationAccessStates).values({
    organizationId: target.id,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  await db.insert(member).values(
    users.map(({ id }) => ({
      id: mintAuthProviderIdValue(),
      organizationId: target.id,
      userId: id,
      role: id === actor.id ? "owner" : "member",
      createdAt: new Date(),
    })),
  );
  // Initialize the auth configuration before measuring either cardinality.
  await getAuth().$context;
  return {
    organizationId: target.id,
    userId: actor.id,
    slug: `new-${target.id.toLowerCase()}`,
    cleanup: async () => {
      await deleteOrganizationsForTest(
        db,
        organizations.map(({ id }) => id),
      );
      await db.delete(user).where(
        inArray(
          user.id,
          users.map(({ id }) => id),
        ),
      );
    },
  };
};

type OrganizationSlugScalingFixture = Awaited<
  ReturnType<typeof seedOrganizationSlugScaling>
>;

export const organizationSlugScalingScenario = {
  name: "organization slug update",
  definition: updateOrganizationSlug,
  seed: seedOrganizationSlugScaling,
  measure: async (fixture: OrganizationSlugScalingFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const request = new Request("https://example.test/v1/organizations/slug");
      const response = await updateOrganizationSlug.handler(
        createTestHandlerContext<
          Parameters<typeof updateOrganizationSlug.handler>[0]
        >({
          user: { id: fixture.userId },
          session: { activeOrganizationId: fixture.organizationId },
          body: { type: "explicit", slug: fixture.slug },
          route: "/v1/organizations/slug",
          request,
          audit: createAuditRecorder({
            organizationId: fixture.organizationId,
            userId: fixture.userId,
            workspaceId: null,
            request,
            server: null,
          }),
          safeDb: NO_DB,
          scopedDb: NO_DB,
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        response.slug !== fixture.slug
      ) {
        return panic(
          "Slug scaling requires the successful production mutation",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    }),
};

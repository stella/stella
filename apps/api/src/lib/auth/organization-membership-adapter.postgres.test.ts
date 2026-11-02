import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization as organizationPlugin } from "better-auth/plugins";
import type { OrganizationOptions } from "better-auth/plugins";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { BETTER_AUTH_ORGANIZATION_OPTIONS } from "@stll/auth-model";

import { member, organization, user } from "@/api/db/auth-schema";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { withBatchedOrganizationMemberships } from "@/api/lib/auth/organization-membership-adapter";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");

const adapterOptions = {
  plugins: [organizationPlugin(BETTER_AUTH_ORGANIZATION_OPTIONS)],
};

type MembershipProjectionCase = {
  name: string;
  options: BetterAuthOptions;
  expectedMetadata: unknown;
};

const projectionSchema = v.array(
  v.object({
    id: v.string(),
    organizationId: v.string(),
    userId: v.string(),
    role: v.string(),
    createdAt: v.date(),
    organization: v.object({
      id: v.string(),
      name: v.string(),
      slug: v.string(),
      createdAt: v.date(),
      metadata: v.optional(v.unknown()),
    }),
  }),
);

if (!databaseUrl || !runPostgresTests) {
  describe.skip("organization membership adapter (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(true);
    });
  });
} else {
  describe("organization membership adapter (postgres)", () => {
    test.each<MembershipProjectionCase>([
      {
        name: "default metadata",
        options: adapterOptions,
        expectedMetadata: JSON.stringify({ label: "fixture" }),
      },
      {
        name: "transformed JSON metadata",
        options: {
          plugins: [
            organizationPlugin({
              ...BETTER_AUTH_ORGANIZATION_OPTIONS,
              schema: {
                organization: {
                  additionalFields: {
                    metadata: {
                      type: "json",
                      required: false,
                      transform: {
                        output: (value) =>
                          typeof value === "string"
                            ? v.parse(
                                v.pipe(
                                  v.string(),
                                  v.parseJson(),
                                  v.record(v.string(), v.unknown()),
                                ),
                                value,
                              )
                            : value,
                      },
                    },
                  },
                },
              },
            } satisfies OrganizationOptions),
          ],
        },
        expectedMetadata: { label: "fixture" },
      },
    ])(
      "batched membership projections retain native keys, nulls and dates with $name",
      async ({ options, expectedMetadata }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const userId = mintAuthProviderId<"user">();
          const organizations = [
            {
              id: mintAuthProviderId<"organization">(),
              name: "Absent optional fields",
              createdAt: CREATED_AT,
            },
            {
              id: mintAuthProviderId<"organization">(),
              name: "Null optional fields",
              logo: null,
              metadata: null,
              createdAt: CREATED_AT,
            },
            {
              id: mintAuthProviderId<"organization">(),
              name: "Present optional fields",
              logo: "https://example.test/logo.png",
              metadata: JSON.stringify({ label: "fixture" }),
              createdAt: CREATED_AT,
            },
          ].map((row) => ({ ...row, slug: row.id }));
          await db.insert(user).values({
            id: userId,
            name: "Membership fixture",
            email: `${userId}@example.test`,
          });
          try {
            await db.insert(organization).values(organizations);
            await db.insert(member).values(
              organizations.map(({ id }) => ({
                id: mintAuthProviderIdValue(),
                organizationId: id,
                userId,
                role: "owner",
                createdAt: CREATED_AT,
              })),
            );
            const raw = drizzleAdapter(
              db,
              AUTH_DATABASE_ADAPTER_OPTIONS,
            )(options);
            const batched = withBatchedOrganizationMemberships(raw);
            const query = {
              model: "member",
              where: [{ field: "userId", value: userId }],
              join: { organization: true },
              sortBy: { field: "id", direction: "asc" },
            } satisfies Parameters<typeof raw.findMany>[0];
            const native = await raw.findMany(query);
            const nativeProjection = v.parse(projectionSchema, native);
            const metadata = nativeProjection.find(
              ({ organization: org }) => org.name === "Present optional fields",
            )?.organization.metadata;
            expect(metadata).toStrictEqual(expectedMetadata);
            const actual = await batched.findMany(query);
            expect(actual).toStrictEqual(native);
            expect(actual).toHaveLength(organizations.length);
            const projected = v.parse(projectionSchema, actual);
            for (const row of projected) {
              expect(row.createdAt).toEqual(CREATED_AT);
              expect(row.organization.createdAt).toEqual(CREATED_AT);
              expect(row.organizationId).toBe(row.organization.id);
            }
          } finally {
            await db.delete(organization).where(
              inArray(
                organization.id,
                organizations.map(({ id }) => id),
              ),
            );
            await db.delete(user).where(eq(user.id, userId));
          }
        });
      },
    );

    test("creator memberships include organizations created inside the same adapter transaction", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const observer = openClient();
        const userId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const membershipId = mintAuthProviderIdValue();
        await db.insert(user).values({
          id: userId,
          name: "Transactional membership fixture",
          email: `${userId}@example.test`,
        });
        try {
          const raw = drizzleAdapter(
            db,
            AUTH_DATABASE_ADAPTER_OPTIONS,
          )(adapterOptions);
          const batched = withBatchedOrganizationMemberships(raw);
          await batched.transaction(async (tx) => {
            await tx.create({
              model: "organization",
              forceAllowId: true,
              data: {
                id: organizationId,
                name: "Uncommitted organization",
                slug: organizationId,
                createdAt: CREATED_AT,
              },
            });
            await tx.create({
              model: "member",
              forceAllowId: true,
              data: {
                id: membershipId,
                organizationId,
                userId,
                role: "owner",
                createdAt: CREATED_AT,
              },
            });
            // A different connection cannot supply this uncommitted join.
            expect(
              await observer.db
                .select({ id: organization.id })
                .from(organization)
                .where(eq(organization.id, organizationId)),
            ).toEqual([]);
            const rows = v.parse(
              projectionSchema,
              await tx.findMany({
                model: "member",
                where: [{ field: "userId", value: userId }],
                join: { organization: true },
              }),
            );
            expect(rows).toHaveLength(1);
            expect(rows.at(0)).toMatchObject({
              id: membershipId,
              organizationId,
              userId,
              role: "owner",
              organization: {
                id: organizationId,
                name: "Uncommitted organization",
                createdAt: CREATED_AT,
              },
            });
          });
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  });
}

import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  auditLogs,
  organizationProfessionalUseAcceptances,
  userProfessionalUseAcceptances,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { getAuth } from "@/api/lib/auth";
import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@/api/lib/professional-use";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const CURRENT_VERSIONS = {
  statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
  termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
};

const userAcceptances = async (userIds: string[]) =>
  await testDb
    .select()
    .from(userProfessionalUseAcceptances)
    .where(inArray(userProfessionalUseAcceptances.userId, userIds));

const organizationAcceptances = async (organizationIds: string[]) =>
  await testDb
    .select()
    .from(organizationProfessionalUseAcceptances)
    .where(
      inArray(
        organizationProfessionalUseAcceptances.organizationId,
        organizationIds.map(brandPersistedOrganizationId),
      ),
    );

const acceptanceAuditEvents = async (organizationId: string) =>
  await testDb
    .select({ userId: auditLogs.userId, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(
          auditLogs.organizationId,
          brandPersistedOrganizationId(organizationId),
        ),
        sql`${auditLogs.metadata}->>'field' = 'professionalUseAcceptance'`,
      ),
    );

describe("professional-use acceptance", () => {
  test("every account and organization created through the auth flows has exactly one acceptance with the current versions", async () => {
    await assertProperty(
      "every account and organization created through the auth flows has exactly one acceptance with the current versions",
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 2 }), {
          minLength: 1,
          maxLength: 3,
        }),
        fc.boolean(),
        async (organizationsPerUser, signInAgain) => {
          const created: { userId: string; organizationIds: string[] }[] = [];
          for (const organizationCount of organizationsPerUser) {
            const email = `professional-use-${Bun.randomUUIDv7()}@stella.dev`;
            // db-await-in-loop: each account signs in through its own OTP round trip
            const person = await signInHuman(email);
            if (signInAgain) {
              await signInHuman(email);
            }
            const organizationIds: string[] = [];
            for (let index = 0; index < organizationCount; index += 1) {
              // db-await-in-loop: organizations are created one at a time, as a person does
              const organization = await getAuth().api.createOrganization({
                body: {
                  name: "Professional use",
                  slug: `professional-use-${Bun.randomUUIDv7()}`,
                },
                headers: person.headers(),
              });
              organizationIds.push(organization.id);
            }
            created.push({ userId: person.userId, organizationIds });
          }

          const users = await userAcceptances(
            created.map(({ userId }) => userId),
          );
          expect(users).toHaveLength(created.length);
          for (const row of users) {
            expect(row).toMatchObject(CURRENT_VERSIONS);
          }

          const expectedOrganizations = created.flatMap(
            ({ userId, organizationIds }) =>
              organizationIds.map((organizationId) => ({
                organizationId,
                acceptedByUserId: userId,
                ...CURRENT_VERSIONS,
              })),
          );
          const organizations = await organizationAcceptances(
            expectedOrganizations.map(({ organizationId }) => organizationId),
          );
          expect(
            organizations.toSorted((a, b) =>
              a.organizationId.localeCompare(b.organizationId),
            ),
          ).toMatchObject(
            expectedOrganizations.toSorted((a, b) =>
              a.organizationId.localeCompare(b.organizationId),
            ),
          );

          for (const {
            organizationId,
            acceptedByUserId,
          } of expectedOrganizations) {
            // db-await-in-loop: a handful of organizations per run
            expect(await acceptanceAuditEvents(organizationId)).toEqual([
              {
                userId: acceptedByUserId,
                metadata: expect.objectContaining({
                  field: "professionalUseAcceptance",
                  ...CURRENT_VERSIONS,
                }),
              },
            ]);
          }
        },
      ),
      { numRuns: 6 },
    );
  });

  test("the request role cannot read an acceptance, even its own", async () => {
    const person = await signInHuman(
      `professional-use-scoped-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const organization = await getAuth().api.createOrganization({
      body: {
        name: "Professional use scoped",
        slug: `professional-use-scoped-${Bun.randomUUIDv7()}`,
      },
      headers: person.headers(),
    });
    const organizationId = brandPersistedOrganizationId(organization.id);
    const userId = brandPersistedUserId(person.userId);
    // The owner connection sees both rows ...
    expect(await userAcceptances([userId])).toHaveLength(1);
    expect(await organizationAcceptances([organizationId])).toHaveLength(1);

    // ... the request role sees neither.
    const scoped = createSafeDb(testDb, [], organizationId, userId);
    const read = await scoped(async (tx) => ({
      users: await tx
        .select()
        .from(userProfessionalUseAcceptances)
        .where(eq(userProfessionalUseAcceptances.userId, userId)),
      organizations: await tx
        .select()
        .from(organizationProfessionalUseAcceptances)
        .where(
          eq(
            organizationProfessionalUseAcceptances.organizationId,
            organizationId,
          ),
        ),
    }));
    if (Result.isOk(read)) {
      expect(read.value).toEqual({ users: [], organizations: [] });
    }
  });
});

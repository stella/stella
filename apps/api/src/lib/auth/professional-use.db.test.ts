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
import Elysia from "elysia";
import fc from "fast-check";

import {
  PROFESSIONAL_USE_REQUIRED_CODE,
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";
import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import {
  auditLogs,
  organizationProfessionalUseAcceptances,
  userProfessionalUseAcceptances,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { meRoute } from "@/api/handlers/me/routes";
import { publicKnowledgeRoute } from "@/api/handlers/public-knowledge/routes";
import {
  acceptAccountProfessionalUse,
  authMacro,
  createAuth,
  getAuth,
} from "@/api/lib/auth";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { signInHuman } from "@/api/tests/helpers/human-session";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
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
  test("every account and organization created through interactive registration has exactly one acceptance with the current versions", async () => {
    await assertProperty(
      "every account and organization created through interactive registration has exactly one acceptance with the current versions",
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
              compareCodeUnit(a.organizationId, b.organizationId),
            ),
          ).toMatchObject(
            expectedOrganizations.toSorted((a, b) =>
              compareCodeUnit(a.organizationId, b.organizationId),
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
    expect(Result.isError(read)).toBe(true);
    if (Result.isError(read)) {
      expect(isPgError(read.error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
    }
  });

  const createOrganizationFor = async (
    person: Awaited<ReturnType<typeof signInHuman>>,
  ) =>
    await getAuth().api.createOrganization({
      body: {
        name: "Professional use creator",
        slug: `professional-use-creator-${Bun.randomUUIDv7()}`,
      },
      headers: person.headers(),
    });

  const signedInProduct = new Elysia()
    .use(authMacro)
    .get("/product", () => ({ served: true }), { validateAuth: true });

  const readProduct = async (person: HumanBrowser) =>
    await signedInProduct.handle(
      new Request("http://localhost/product", { headers: person.headers() }),
    );

  const readOwnState = async (person: HumanBrowser) =>
    await meRoute.handle(
      new Request("http://localhost/me/professional-use", {
        headers: person.headers(),
      }),
    );

  const accept = async (person: HumanBrowser, statementVersion: string) => {
    const headers = person.headers();
    headers.set("content-type", "application/json");
    return await meRoute.handle(
      new Request("http://localhost/me/professional-use", {
        method: "POST",
        headers,
        body: JSON.stringify({ statementVersion }),
      }),
    );
  };

  test("an agent-provisioned account records no acceptance, is refused the product until it accepts on its first interactive sign-in, and keeps its MCP access throughout", async () => {
    const email = `professional-use-agent-${Bun.randomUUIDv7()}@stella.dev`;
    const created = await getAuth().api.createAgentUser({
      body: { email, name: "Agent", emailVerified: true },
    });
    const userId = brandPersistedUserId(created.id);
    // The default organization agent provisioning bootstraps for the account.
    const organization = await getAuth().api.createOrganization({
      body: {
        name: "Agent workspace",
        slug: `agent-${Bun.randomUUIDv7()}`,
        userId: created.id,
        keepCurrentActiveOrganization: true,
      },
    });
    const organizationId = brandPersistedOrganizationId(organization.id);
    expect(await userAcceptances([userId])).toEqual([]);
    expect(await organizationAcceptances([organizationId])).toEqual([]);
    expect(await acceptanceAuditEvents(organizationId)).toEqual([]);

    // MCP never consults the acceptance: the agent's credentials open the
    // organization before and after the account accepts.
    const openMcp = async () =>
      await resolveMcpSessionContext(
        { userId, organizationId, scopes: ["stella:read"] },
        { request: new Request("http://localhost/mcp") },
      );
    await openMcp();

    // The first interactive sign-in: the account exists, so nothing is
    // created, and the session is refused the product.
    const person = await signInHuman(email);
    await person.setActiveOrganization(organizationId);
    expect(await (await readOwnState(person)).json()).toEqual({
      status: "required",
    });
    const refused = await readProduct(person);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      code: PROFESSIONAL_USE_REQUIRED_CODE,
      message: expect.any(String),
    });

    // Accepting a statement the page did not show records nothing.
    const outdated = await accept(person, "1999-01");
    expect(outdated.status).toBe(409);
    expect(await userAcceptances([userId])).toEqual([]);
    expect((await readProduct(person)).status).toBe(403);

    const accepted = await accept(person, PROFESSIONAL_USE_STATEMENT_VERSION);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      status: "accepted",
      ...CURRENT_VERSIONS,
    });
    expect(await userAcceptances([userId])).toMatchObject([CURRENT_VERSIONS]);
    // The organization it owns is recorded the way creation records one.
    expect(await organizationAcceptances([organizationId])).toMatchObject([
      { acceptedByUserId: userId, ...CURRENT_VERSIONS },
    ]);
    const audited = [
      {
        userId,
        metadata: expect.objectContaining({
          field: "professionalUseAcceptance",
          ...CURRENT_VERSIONS,
        }),
      },
    ];
    expect(await acceptanceAuditEvents(organizationId)).toEqual(audited);
    expect((await readProduct(person)).status).toBe(200);
    expect(await (await readOwnState(person)).json()).toMatchObject({
      status: "accepted",
    });

    // Accepting again keeps the first acceptance and audits nothing new.
    expect(
      (await accept(person, PROFESSIONAL_USE_STATEMENT_VERSION)).status,
    ).toBe(200);
    expect(await userAcceptances([userId])).toHaveLength(1);
    expect(await acceptanceAuditEvents(organizationId)).toEqual(audited);
    await openMcp();
  });

  test.each([
    ["no statement version", null],
    ["a stale statement version", "2000-01"],
  ] as const)(
    "a registration naming %s records no acceptance and is refused the product until it accepts",
    async (_name, displayedStatementVersion) => {
      const person = await signInHuman(
        `professional-use-unconfirmed-${Bun.randomUUIDv7()}@stella.dev`,
        { displayedStatementVersion },
      );
      const userId = brandPersistedUserId(person.userId);
      expect(await userAcceptances([userId])).toEqual([]);
      const organization = await createOrganizationFor(person);
      const organizationId = brandPersistedOrganizationId(organization.id);
      expect(await organizationAcceptances([organizationId])).toEqual([]);
      await person.setActiveOrganization(organizationId);
      expect(await (await readOwnState(person)).json()).toEqual({
        status: "required",
      });
      expect((await readProduct(person)).status).toBe(403);

      expect(
        (await accept(person, PROFESSIONAL_USE_STATEMENT_VERSION)).status,
      ).toBe(200);
      expect(await userAcceptances([userId])).toMatchObject([CURRENT_VERSIONS]);
      expect(await organizationAcceptances([organizationId])).toMatchObject([
        { acceptedByUserId: userId, ...CURRENT_VERSIONS },
      ]);
      expect((await readProduct(person)).status).toBe(200);
    },
  );

  test("a registration naming the current statement version records that version", async () => {
    const person = await signInHuman(
      `professional-use-confirmed-${Bun.randomUUIDv7()}@stella.dev`,
      { displayedStatementVersion: PROFESSIONAL_USE_STATEMENT_VERSION },
    );
    expect(await userAcceptances([person.userId])).toMatchObject([
      { statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION },
    ]);
  });

  test("public knowledge answers an account that has not accepted exactly as an anonymous visitor", async () => {
    const person = await signInHuman(
      `professional-use-public-${Bun.randomUUIDv7()}@stella.dev`,
      { displayedStatementVersion: null },
    );
    const organization = await createOrganizationFor(person);
    await person.setActiveOrganization(organization.id);
    expect((await readProduct(person)).status).toBe(403);

    const previous = env.FEATURE_PUBLIC_KNOWLEDGE;
    env.FEATURE_PUBLIC_KNOWLEDGE = true;
    try {
      for (const path of [
        "/public/knowledge/template-packs",
        "/public/knowledge/playbook-starters",
      ]) {
        const anonymous = await publicKnowledgeRoute.handle(
          new Request(`http://localhost${path}`),
        );
        const signedIn = await publicKnowledgeRoute.handle(
          new Request(`http://localhost${path}`, { headers: person.headers() }),
        );
        expect(anonymous.status).toBe(200);
        expect(signedIn.status).toBe(200);
        expect(await signedIn.text()).toBe(await anonymous.text());
      }
    } finally {
      env.FEATURE_PUBLIC_KNOWLEDGE = previous;
    }
  });

  test("the operator-created review account records no acceptance", async () => {
    const email = `professional-use-review-${Bun.randomUUIDv7()}@stella.dev`;
    const previous = {
      email: env.APP_REVIEW_ACCOUNT_EMAIL,
      organizationId: env.APP_REVIEW_ORGANIZATION_ID,
    };
    env.APP_REVIEW_ACCOUNT_EMAIL = email;
    env.APP_REVIEW_ORGANIZATION_ID = `review-${Bun.randomUUIDv7()}`;
    try {
      const created = await createAuth().api.createReviewAccountUser({
        body: { email },
      });
      expect(created.email).toBe(email);
      expect(await userAcceptances([brandPersistedUserId(created.id)])).toEqual(
        [],
      );
    } finally {
      env.APP_REVIEW_ACCOUNT_EMAIL = previous.email;
      env.APP_REVIEW_ORGANIZATION_ID = previous.organizationId;
    }
  });

  test("an organization created before its creator accepts is recorded when the creator accepts", async () => {
    const person = await signInHuman(
      `professional-use-pending-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const userId = brandPersistedUserId(person.userId);
    // As if the account had been created where the statement is not shown.
    await testDb
      .delete(userProfessionalUseAcceptances)
      .where(eq(userProfessionalUseAcceptances.userId, userId));
    const organization = await createOrganizationFor(person);
    const organizationId = brandPersistedOrganizationId(organization.id);
    expect(await organizationAcceptances([organizationId])).toEqual([]);
    expect(await acceptanceAuditEvents(organizationId)).toEqual([]);

    await acceptAccountProfessionalUse(userId);

    expect(await organizationAcceptances([organizationId])).toMatchObject([
      { acceptedByUserId: userId, ...CURRENT_VERSIONS },
    ]);
    expect(await acceptanceAuditEvents(organizationId)).toHaveLength(1);
  });

  test("an organization carries the versions its creator accepted, not the current ones", async () => {
    const person = await signInHuman(
      `professional-use-older-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const accepted = { statementVersion: "2000-01", termsVersion: "2000-02" };
    await testDb
      .update(userProfessionalUseAcceptances)
      .set(accepted)
      .where(eq(userProfessionalUseAcceptances.userId, person.userId));

    const organization = await createOrganizationFor(person);

    expect(await organizationAcceptances([organization.id])).toMatchObject([
      { acceptedByUserId: person.userId, ...accepted },
    ]);
    expect(await acceptanceAuditEvents(organization.id)).toEqual([
      {
        userId: person.userId,
        metadata: expect.objectContaining(accepted),
      },
    ]);
  });
});

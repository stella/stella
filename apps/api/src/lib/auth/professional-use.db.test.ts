import { PGlite } from "@electric-sql/pglite";
import { panic, Result } from "better-result";
import {
  afterAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";
import * as v from "valibot";

import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_REQUIRED_CODE,
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";
import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { user } from "@/api/db/auth-schema";
import {
  auditLogs,
  organizationProfessionalUseAcceptances,
  PROFESSIONAL_USE_ACCEPTANCE_SOURCE,
  userProfessionalUseAcceptances,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { meRoute } from "@/api/handlers/me/routes";
import { publicKnowledgeRoute } from "@/api/handlers/public-knowledge/routes";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { createAuth, getAuth } from "@/api/lib/auth";
import { recordAccountProfessionalUse } from "@/api/lib/auth/professional-use";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
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
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createTestState } from "@/api/tests/helpers/test-state";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testFetchState = createTestFetch();

const testState = createTestState({ file: import.meta.path, config: env });
setDefaultTimeout(120_000);

let testDb: TestDatabase;

testState.beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const CURRENT_VERSIONS = {
  statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
  termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
};
const REGISTRATION_ACCEPTANCE = {
  ...CURRENT_VERSIONS,
  source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.registration,
};

const SOURCE_MIGRATION = new URL(
  "../../../drizzle/20261022120000_professional_use_acceptance_source/migration.sql",
  import.meta.url,
);
const BACKFILL_MIGRATION = new URL(
  "../../../drizzle/20261022120100_professional_use_acceptance_owner_backfill/migration.sql",
  import.meta.url,
);

const migrationSql = async (migration: URL): Promise<string> =>
  await Bun.file(migration).text();

describe("professional-use provenance migrations", () => {
  test("the owner backfill versions stay coupled to the current contract", async () => {
    const source = await migrationSql(BACKFILL_MIGRATION);
    const versions =
      /SELECT u\.id, '([^']+)', '([^']+)', 'owner_backfill_2026_10_22'/u.exec(
        source,
      );
    expect(versions?.slice(1)).toEqual([
      PROFESSIONAL_USE_STATEMENT_VERSION,
      PROFESSIONAL_USE_TERMS_VERSION,
    ]);
  });

  test("every TypeScript writer supplies a typed acceptance source", async () => {
    const writers: string[] = [];
    const glob = new Bun.Glob("src/**/*.ts");
    for await (const path of glob.scan({
      cwd: new URL("../../..", import.meta.url).pathname,
    })) {
      if (path.endsWith(".test.ts")) {
        continue;
      }
      const source = await Bun.file(
        new URL(`../../../${path}`, import.meta.url),
      ).text();
      if (source.includes(".insert(userProfessionalUseAcceptances)")) {
        writers.push(path);
      }
    }
    expect(writers).toEqual(["src/lib/auth/professional-use.ts"]);
    const writer = await Bun.file(
      new URL("professional-use.ts", import.meta.url),
    ).text();
    expect(writer).toContain(
      "source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.registration",
    );
    expect(writer).toContain(
      "source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive",
    );
  });

  test("the real migration path preserves existing rows and backfills only human accounts once", async () => {
    await using db = await PGlite.create();
    await db.exec(`
      CREATE TABLE "user" (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL
      );
      CREATE TABLE organization (
        id text PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL
      );
      CREATE TABLE member (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        organization_id text NOT NULL,
        role text NOT NULL
      );
      CREATE TABLE agent_registration (
        id text PRIMARY KEY,
        bound_user_id text
      );
      CREATE TABLE agent_delegation (
        id text PRIMARY KEY,
        user_id text NOT NULL
      );
      CREATE TABLE user_professional_use_acceptances (
        user_id text PRIMARY KEY,
        statement_version text NOT NULL,
        terms_version text NOT NULL,
        accepted_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO "user" (id, name, email) VALUES
        ('existing', 'Existing', 'existing@example.test'),
        ('human', 'Human', 'human@example.test'),
        ('delegating-human', 'Delegating Human', 'delegating-human@example.test'),
        ('registered-human', 'Registered Human', 'registered-human@example.test'),
        ('smoke-ai-user-stella', 'Synthetic Agent', 'agent@example.test'),
        ('reviewer', 'Reviewer', 'reviewer@example.test');
      INSERT INTO user_professional_use_acceptances VALUES
        ('existing', '1999-01', '1999-02', '2000-01-02T03:04:05Z');
      INSERT INTO agent_delegation VALUES ('delegation', 'delegating-human');
      INSERT INTO agent_registration VALUES ('registration', 'registered-human');
      INSERT INTO organization VALUES
        ('review-org', 'Sample law firm', 'review-review-org');
      INSERT INTO member VALUES
        ('review-member', 'reviewer', 'review-org', 'owner');
    `);
    const before = await db.query<{
      user_id: string;
      statement_version: string;
      terms_version: string;
      accepted_at: Date;
    }>(
      `SELECT user_id, statement_version, terms_version, accepted_at
       FROM user_professional_use_acceptances ORDER BY user_id`,
    );

    await db.exec(await migrationSql(SOURCE_MIGRATION));
    await db.exec(await migrationSql(BACKFILL_MIGRATION));
    const once = await db.query(
      `SELECT user_id, statement_version, terms_version, accepted_at, source
       FROM user_professional_use_acceptances ORDER BY user_id`,
    );
    expect(once.rows).toEqual([
      {
        user_id: "delegating-human",
        statement_version: PROFESSIONAL_USE_STATEMENT_VERSION,
        terms_version: PROFESSIONAL_USE_TERMS_VERSION,
        accepted_at: expect.any(Date),
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.ownerBackfill20261022,
      },
      {
        ...before.rows[0],
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.recordedBeforeProvenance,
      },
      {
        user_id: "human",
        statement_version: PROFESSIONAL_USE_STATEMENT_VERSION,
        terms_version: PROFESSIONAL_USE_TERMS_VERSION,
        accepted_at: expect.any(Date),
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.ownerBackfill20261022,
      },
      {
        user_id: "registered-human",
        statement_version: PROFESSIONAL_USE_STATEMENT_VERSION,
        terms_version: PROFESSIONAL_USE_TERMS_VERSION,
        accepted_at: expect.any(Date),
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.ownerBackfill20261022,
      },
    ]);
    expect(
      (
        await db.query(
          `SELECT user_id FROM user_professional_use_acceptances
           WHERE user_id IN ('smoke-ai-user-stella', 'reviewer')`,
        )
      ).rows,
    ).toEqual([]);

    await db.exec(await migrationSql(BACKFILL_MIGRATION));
    expect(
      (
        await db.query(
          `SELECT user_id, statement_version, terms_version, accepted_at, source
           FROM user_professional_use_acceptances ORDER BY user_id`,
        )
      ).rows,
    ).toEqual(once.rows);
  });

  test("the previous release keeps recording acceptances while instances roll over", async () => {
    await using db = await PGlite.create();
    await db.exec(`
      CREATE TABLE user_professional_use_acceptances (
        user_id text PRIMARY KEY,
        statement_version text NOT NULL,
        terms_version text NOT NULL,
        accepted_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.exec(await migrationSql(SOURCE_MIGRATION));
    // A retry after any committed stage reruns the whole file; it converges.
    await db.exec(await migrationSql(SOURCE_MIGRATION));

    // The previous release's insert names no source.
    await db.exec(`
      INSERT INTO user_professional_use_acceptances
        (user_id, statement_version, terms_version)
      VALUES ('previous-release', '2026-10', '2026-10');
    `);
    expect(
      (
        await db.query(
          `SELECT source FROM user_professional_use_acceptances
           WHERE user_id = 'previous-release'`,
        )
      ).rows,
    ).toEqual([
      { source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.recordedBeforeProvenance },
    ]);
    const refused = await rejectionOf(
      db.exec(`
        INSERT INTO user_professional_use_acceptances
          (user_id, statement_version, terms_version, source)
        VALUES ('unknown-source', '2026-10', '2026-10', 'guessed');
      `),
    );
    expect(String(refused)).toContain(
      "user_professional_use_acceptances_source_values",
    );
  });
});

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

const acceptanceProvenanceCases = {
  [PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive]: {
    source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
    performerType: "user",
    triggerType: "direct",
    triggerSource: null,
  },
  [PROFESSIONAL_USE_ACCEPTANCE_SOURCE.operatorProvisioning]: {
    source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.operatorProvisioning,
    performerType: "service",
    triggerType: "system",
    triggerSource: "review-account",
  },
} as const satisfies Record<
  Parameters<typeof recordAccountProfessionalUse>[0]["source"],
  Pick<
    typeof auditLogs.$inferSelect,
    "performerType" | "triggerType" | "triggerSource"
  > & { source: Parameters<typeof recordAccountProfessionalUse>[0]["source"] }
>;

describe("professional-use acceptance", () => {
  test("a Google registration started by the web sign-in panel records acceptance from OAuth state", async () => {
    testState.patchConfig({
      GOOGLE_AUTH_CLIENT_ID: "professional-use-google-client",
      GOOGLE_AUTH_CLIENT_SECRET: "professional-use-google-secret",
    });
    const auth = createAuth();
    const email = `professional-use-google-${Bun.randomUUIDv7()}@stella.dev`;
    const origin = "http://localhost:3001";
    const started = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/law/cze/cases/ns/fixture",
          additionalData: {
            [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
              PROFESSIONAL_USE_STATEMENT_VERSION,
          },
        }),
      }),
    );
    expect(started.status).toBe(200);
    const { url } = v.parse(
      v.object({ url: v.string() }),
      await started.json(),
    );
    const state = new URL(url).searchParams.get("state");
    expect(state).not.toBeNull();
    const cookie = started.headers
      .getSetCookie()
      .map((value) => value.split(";").at(0) ?? "")
      .join("; ");
    const encodeJwtPart = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const idToken = [
      encodeJwtPart({ alg: "RS256", typ: "JWT" }),
      encodeJwtPart({
        aud: "professional-use-google-client",
        email,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "https://accounts.google.com",
        name: "Professional use reader",
        sub: `professional-use-google-${Bun.randomUUIDv7()}`,
      }),
      "fixture-signature",
    ].join(".");
    const providerFetch = Object.assign(
      mock(
        Object.assign(
          async (input: string | URL | Request) => {
            const requestUrl =
              input instanceof Request ? input.url : String(input);
            if (requestUrl.includes("oauth2.googleapis.com/token")) {
              return Response.json({
                access_token: "professional-use-access-token",
                token_type: "Bearer",
                expires_in: 3600,
                id_token: idToken,
              });
            }
            return new Response("Unexpected provider request", { status: 500 });
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      ),
      { preconnect: globalThis.fetch.preconnect },
    );
    testFetchState.set(providerFetch);
    try {
      const callback = await auth.handler(
        new Request(
          `${origin}/api/auth/callback/google?code=fixture&state=${encodeURIComponent(state ?? "")}`,
          { headers: { cookie } },
        ),
      );
      expect(callback.status).toBe(302);
    } finally {
      testFetchState.restore();
    }
    const createdUser = await testDb
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1)
      .then((rows) => rows.at(0));
    expect(createdUser).toBeDefined();
    if (createdUser === undefined) {
      return;
    }
    expect(await userAcceptances([createdUser.id])).toMatchObject([
      CURRENT_VERSIONS,
    ]);
  });

  test.each(Object.values(acceptanceProvenanceCases))(
    "$source acceptance preserves its account source and audit performer on replay",
    async ({ source, ...execution }) => {
      const person = await signInHuman(
        `professional-use-origin-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const userId = brandPersistedUserId(person.userId);
      await testDb
        .delete(userProfessionalUseAcceptances)
        .where(eq(userProfessionalUseAcceptances.userId, userId));
      const organization = await createOrganizationFor(person);
      const organizationId = brandPersistedOrganizationId(organization.id);
      expect(await organizationAcceptances([organizationId])).toEqual([]);

      expect(
        (await recordAccountProfessionalUse({ userId, source })).isOk(),
      ).toBe(true);
      const accepted = await userAcceptances([userId]);
      expect(accepted).toMatchObject([{ source, ...CURRENT_VERSIONS }]);
      const readExecution = async () =>
        await testDb
          .select({
            performerType: auditLogs.performerType,
            performerId: auditLogs.performerId,
            triggerType: auditLogs.triggerType,
            triggerSource: auditLogs.triggerSource,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, organizationId),
              sql`${auditLogs.metadata}->>'field' = 'professionalUseAcceptance'`,
            ),
          );
      const events = await readExecution();
      expect(events).toEqual([
        {
          ...execution,
          performerId:
            execution.performerType === "user" ? userId : "review-account",
        },
      ]);

      for (const next of Object.values(acceptanceProvenanceCases)) {
        expect(
          (
            await recordAccountProfessionalUse({ userId, source: next.source })
          ).isOk(),
        ).toBe(true);
        expect(await userAcceptances([userId])).toEqual(accepted);
        expect(await readExecution()).toEqual(events);
      }
    },
  );

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
            expect(row).toMatchObject(REGISTRATION_ACCEPTANCE);
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

  // A member route stands for any signed-in product route.
  const server = serveForTest(
    createHttpApp({
      middleware: [errorBoundary],
      routes: [
        ...routes({
          "/product": {
            GET: defineEndpoint.member({}, () => ({ served: true })),
          },
        }),
        ...meRoute,
        ...publicKnowledgeRoute,
      ],
    }),
  );
  afterAll(async () => {
    await server.stop();
  });

  const readProduct = async (person: HumanBrowser) =>
    await server.fetch("http://localhost/product", {
      headers: person.headers(),
    });

  const readOwnState = async (person: HumanBrowser) =>
    await server.fetch("http://localhost/me/professional-use", {
      headers: person.headers(),
    });

  const accept = async (person: HumanBrowser, statementVersion: string) => {
    const headers = person.headers();
    headers.set("content-type", "application/json");
    return await server.fetch("http://localhost/me/professional-use", {
      method: "POST",
      headers,
      body: JSON.stringify({ statementVersion }),
    });
  };

  test("acceptance reads and writes the authenticated account without changing another account", async () => {
    const other = await signInHuman(
      `professional-use-other-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const otherOrganization = await createOrganizationFor(other);
    const otherOrganizationId = brandPersistedOrganizationId(
      otherOrganization.id,
    );
    await testDb
      .update(userProfessionalUseAcceptances)
      .set({
        statementVersion: "previous-statement",
        termsVersion: "previous-terms",
      })
      .where(eq(userProfessionalUseAcceptances.userId, other.userId));
    // A retained organization can still be awaiting its owner's receipt.
    await testDb
      .delete(organizationProfessionalUseAcceptances)
      .where(
        eq(
          organizationProfessionalUseAcceptances.organizationId,
          otherOrganizationId,
        ),
      );
    const otherAcceptances = await userAcceptances([other.userId]);
    const otherAudits = await acceptanceAuditEvents(otherOrganizationId);

    const person = await signInHuman(
      `professional-use-own-${Bun.randomUUIDv7()}@stella.dev`,
      { displayedStatementVersion: null },
    );
    const organization = await createOrganizationFor(person);
    const organizationId = brandPersistedOrganizationId(organization.id);
    await person.setActiveOrganization(organizationId);
    expect(await (await readOwnState(person)).json()).toEqual({
      status: "required",
    });

    const accepted = await accept(person, PROFESSIONAL_USE_STATEMENT_VERSION);
    expect(accepted.status).toBe(200);
    const ownAcceptance =
      (await userAcceptances([person.userId])).at(0) ??
      panic("Missing authenticated account acceptance");
    expect(await accepted.json()).toEqual({
      status: "accepted",
      statementVersion: ownAcceptance.statementVersion,
      termsVersion: ownAcceptance.termsVersion,
      acceptedAt: ownAcceptance.acceptedAt.toISOString(),
    });
    expect(ownAcceptance).toMatchObject({
      ...CURRENT_VERSIONS,
      source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
    });
    expect(await organizationAcceptances([organizationId])).toMatchObject([
      { acceptedByUserId: person.userId, ...CURRENT_VERSIONS },
    ]);
    expect(await userAcceptances([other.userId])).toEqual(otherAcceptances);
    expect(await organizationAcceptances([otherOrganizationId])).toEqual([]);
    expect(await acceptanceAuditEvents(otherOrganizationId)).toEqual(
      otherAudits,
    );
  });

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
    expect(await userAcceptances([userId])).toMatchObject([
      {
        ...CURRENT_VERSIONS,
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
      },
    ]);
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
      {
        statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.registration,
      },
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

    testState.setConfig("FEATURE_PUBLIC_KNOWLEDGE", true);
    for (const path of [
      "/public/knowledge/template-packs",
      "/public/knowledge/playbook-starters",
    ]) {
      const anonymous = await server.fetch(`http://localhost${path}`);
      const signedIn = await server.fetch(`http://localhost${path}`, {
        headers: person.headers(),
      });
      expect(anonymous.status).toBe(200);
      expect(signedIn.status).toBe(200);
      expect(await signedIn.text()).toBe(await anonymous.text());
    }
  });

  test("the operator-created review account records no acceptance", async () => {
    const email = `professional-use-review-${Bun.randomUUIDv7()}@stella.dev`;
    testState.setConfig("APP_REVIEW_ACCOUNT_EMAIL", email);
    testState.setConfig(
      "APP_REVIEW_ORGANIZATION_ID",
      `review-${Bun.randomUUIDv7()}`,
    );
    const created = await createAuth().api.createReviewAccountUser({
      body: { email },
    });
    expect(created.email).toBe(email);
    expect(await userAcceptances([brandPersistedUserId(created.id)])).toEqual(
      [],
    );
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

    const accepted = await recordAccountProfessionalUse({
      userId,
      source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
    });
    expect(Result.isOk(accepted)).toBe(true);

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

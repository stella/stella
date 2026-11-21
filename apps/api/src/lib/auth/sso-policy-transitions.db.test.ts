import { panic } from "better-result";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  PROFESSIONAL_USE_STATEMENT_VERSION,
  PROFESSIONAL_USE_TERMS_VERSION,
} from "@stll/api-contract/professional-use";
import { SSO_SIGN_IN_REQUIRED_CODE } from "@stll/api-contract/sso";
import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import { ssoProvider } from "@/api/db/auth-schema";
import {
  PROFESSIONAL_USE_ACCEPTANCE_SOURCE,
  userProfessionalUseAcceptances,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import {
  getAuth,
  resolveUserRealtimeAuthorization,
  resolveWorkspaceRealtimeAudience,
} from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { toSafeId } from "@/api/lib/branded-types";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import type { HumanBrowser } from "@/api/tests/helpers/human-session";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import {
  grantOAuthClient,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";
import {
  addMember,
  createIdentityProvider,
  createOrganization,
  registerProvider,
  sessionOf,
  setSsoRequirement,
  signedInBrowser,
  signInWithSso,
  unique,
  verifiedClaims,
} from "@/api/tests/helpers/sso-identity-provider";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });
// timeout: one test walks a policy through four states with real sign-ins,
// OAuth grants and refreshes on an in-process database.
setDefaultTimeout(180_000);

let testDb: TestDatabase;

testState.beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

type Surfaces = {
  /** A member route of the product. */
  memberRoute: number;
  /** The organization plugin's member list for the organization. */
  organizationMembers: number;
  /** A refresh of the person's existing OAuth grant. */
  grantRefresh: number;
  /** Whether the person's user-channel stream still receives events. */
  userStream: boolean;
  /** Whether the person's matter stream still receives events. */
  matterStream: boolean;
};

describe("an organization's SSO requirement across every surface", () => {
  test("holds member routes, organization endpoints, OAuth grants and open streams to one decision as the policy changes", async () => {
    testState.setConfig("FEATURE_ENTERPRISE_SSO", true);
    const idp = await createIdentityProvider();
    const owner = await signInHuman(`sso-matrix-owner-${unique()}@stella.dev`);
    const organization = await createOrganization(owner, "matrix");
    const domain = `matrix-${unique()}.test`;
    const provider = await registerProvider(testDb, organization.id, [domain]);
    const ssoPerson = signedInBrowser(
      await signInWithSso(
        idp,
        provider.providerId,
        verifiedClaims(`matrix-${unique()}`, `person-${unique()}@${domain}`),
      ),
    );
    await addMember(testDb, organization.id, ssoPerson.userId);
    // The SSO account accepts the professional-use statement as its first
    // interactive sign-in would.
    await testDb.insert(userProfessionalUseAcceptances).values({
      userId: ssoPerson.userId,
      statementVersion: PROFESSIONAL_USE_STATEMENT_VERSION,
      termsVersion: PROFESSIONAL_USE_TERMS_VERSION,
      source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
    });
    await owner.setActiveOrganization(organization.id);
    await ssoPerson.setActiveOrganization(organization.id);

    const matterId = toSafeId<"workspace">(Bun.randomUUIDv7());
    await testDb.insert(workspaces).values({
      id: matterId,
      organizationId: toSafeId<"organization">(organization.id),
      clientId: null,
      name: "Matrix matter",
      reference: `MATRIX-${unique()}`,
    });
    await testDb.insert(workspaceMembers).values(
      [owner.userId, ssoPerson.userId].map((userId) => ({
        id: toSafeId<"workspaceMember">(Bun.randomUUIDv7()),
        workspaceId: matterId,
        userId,
      })),
    );

    // Each person's grant is minted while the organization does not yet
    // require SSO.
    const refreshTokens = new Map<HumanBrowser, string>();
    const clients = new Map<
      HumanBrowser,
      Awaited<ReturnType<typeof registerOAuthClient>>
    >();
    for (const person of [owner, ssoPerson]) {
      const client = await registerOAuthClient();
      clients.set(person, client);
      refreshTokens.set(
        person,
        (await grantOAuthClient(person, client)).refreshToken,
      );
    }

    const server = serveForTest(
      createHttpApp({
        middleware: [errorBoundary],
        routes: [
          ...routes({
            "/product": {
              GET: defineEndpoint.member({}, () => ({ served: true })),
            },
          }),
        ],
      }),
    );
    const surfaces = async (person: HumanBrowser): Promise<Surfaces> => {
      const sessionId = (await sessionOf(person.cookieHeader()))?.session.id;
      if (sessionId === undefined) {
        return panic("the person's session ended");
      }
      const memberRoute = await server.fetch("http://localhost/product", {
        headers: person.headers(),
      });
      const listUrl = new URL(getAuthEndpointUrl("organization/list-members"));
      listUrl.searchParams.set("organizationId", organization.id);
      const organizationMembers = await getAuth().handler(
        new Request(listUrl.toString(), { headers: person.headers() }),
      );
      if (organizationMembers.status === 403) {
        expect(await organizationMembers.json()).toMatchObject({
          code: SSO_SIGN_IN_REQUIRED_CODE,
        });
      }
      if (memberRoute.status === 403) {
        expect(await memberRoute.json()).toMatchObject({
          code: SSO_SIGN_IN_REQUIRED_CODE,
        });
      }
      const refreshed = await refreshOAuthGrant({
        client:
          clients.get(person) ??
          panic("the fixture has no grant for this person"),
        refreshToken:
          refreshTokens.get(person) ??
          panic("the fixture has no grant for this person"),
      });
      if (refreshed.ok) {
        const body: unknown = await refreshed.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "refresh_token" in body &&
          typeof body.refresh_token === "string"
        ) {
          refreshTokens.set(person, body.refresh_token);
        }
      }
      const userAudience = await resolveUserRealtimeAuthorization(
        {
          organizationId: toSafeId<"organization">(organization.id),
          sessionIds: [sessionId],
          userId: person.userId,
        },
        testDb,
      );
      const matterAudience = await resolveWorkspaceRealtimeAudience(
        { sessionIds: [sessionId], workspaceId: matterId },
        testDb,
      );
      return {
        memberRoute: memberRoute.status,
        organizationMembers: organizationMembers.status,
        grantRefresh: refreshed.status,
        userStream: userAudience.liveSessionIds.has(sessionId),
        matterStream: matterAudience.has(sessionId),
      };
    };
    const admitted: Surfaces = {
      memberRoute: 200,
      organizationMembers: 200,
      grantRefresh: 200,
      userStream: true,
      matterStream: true,
    };
    const refused: Surfaces = {
      memberRoute: 403,
      organizationMembers: 403,
      grantRefresh: 400,
      userStream: false,
      matterStream: false,
    };

    try {
      // No policy: everyone is admitted everywhere.
      expect(await surfaces(owner)).toEqual(admitted);
      expect(await surfaces(ssoPerson)).toEqual(admitted);

      // Required: only the session the organization's provider created.
      await setSsoRequirement(testDb, organization.id, "required");
      expect(await surfaces(owner)).toEqual(refused);
      expect(await surfaces(ssoPerson)).toEqual(admitted);
      // A new grant cannot be minted around the requirement.
      expect(
        String(
          await rejectionOf(
            grantOAuthClient(owner, await registerOAuthClient()),
          ),
        ),
      ).toContain(SSO_SIGN_IN_REQUIRED_CODE);
      // Recovery stays open: the refused session still lists and switches
      // organizations, and is never signed out.
      const listed = await getAuth().handler(
        new Request(getAuthEndpointUrl("organization/list"), {
          headers: owner.headers(),
        }),
      );
      expect(listed.status).toBe(200);

      // Removing the provider ends what its sessions reach.
      await testDb.delete(ssoProvider).where(eq(ssoProvider.id, provider.id));
      expect(await surfaces(ssoPerson)).toEqual(refused);

      // Optional again: the same sessions are admitted. A grant whose refresh
      // the requirement refused stays ended; the person grants again.
      await setSsoRequirement(testDb, organization.id, "optional");
      const afterRefusal = { ...admitted, grantRefresh: 400 };
      expect(await surfaces(owner)).toEqual(afterRefusal);
      expect(await surfaces(ssoPerson)).toEqual(afterRefusal);
      const regranted = await grantOAuthClient(
        owner,
        await registerOAuthClient(),
      );
      expect(regranted.refreshToken).toBeString();
    } finally {
      await server.stop();
    }
  });
});

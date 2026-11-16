import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import { member, organization, session, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { PROFESSIONAL_USE_ACCEPTANCE_SOURCE } from "@/api/db/schema";
import {
  createMemberAuthenticator,
  resolveMemberAuthorization,
  resolveValidateAuth,
} from "@/api/lib/auth";
import { recordAccountProfessionalUse } from "@/api/lib/auth/professional-use";
import { isMemberRole } from "@/api/lib/member-roles";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

// The member lookup and the member's connections read through the root
// pool, so the fixture is written through it too.
const db = rootDb;
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const clock = createTestClock();

const requestContext = () => ({
  request: new Request("http://localhost/v1/chat/threads"),
  route: "/v1/chat/threads",
  server: null,
  set: { headers: {} },
  params: {},
  query: {},
});

if (!databaseUrl || !enabled) {
  describe.skip("member context (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("member context (postgres)", () => {
    test("a session request and its identity build the same member context", async () => {
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const sessionId = `session-${userId}`;
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Member context fixture",
          slug: organizationId,
          createdAt: new Date(clock.now()),
        });
        await recordNewOrganizationAccessState(db, {
          organizationId,
          now: new Date(clock.now()),
        });
        await db.insert(user).values({
          id: userId,
          name: "Fixture member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        // The professional-use gate admits only an account that accepted.
        const accepted = await recordAccountProfessionalUse({
          userId,
          source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
        });
        expect(accepted.isOk()).toBe(true);
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(clock.now()),
        });
        await db.insert(session).values({
          id: sessionId,
          token: `token-${userId}`,
          userId,
          activeOrganizationId: organizationId,
          expiresAt: new Date(clock.now() + 60 * 60 * 1000),
          updatedAt: new Date(clock.now()),
        });
        const [storedSession] = await db
          .select()
          .from(session)
          .where(eq(session.id, sessionId));
        const [storedUser] = await db
          .select()
          .from(user)
          .where(eq(user.id, userId));
        if (storedSession === undefined || storedUser === undefined) {
          panic("The fixture session must be stored");
        }

        const viaRequest = await createMemberAuthenticator({
          getSession: async () => ({
            headers: new Headers(),
            response: { session: storedSession, user: storedUser },
          }),
        })(requestContext(), {});
        if (!viaRequest.ok) {
          panic("The fixture member must authenticate");
        }

        const authorization = await resolveMemberAuthorization(
          { organizationId, userId, workspaceId: undefined },
          db,
        );
        if (authorization === null || !isMemberRole(authorization.role)) {
          panic("The fixture member must have a role");
        }
        const viaIdentity = await resolveValidateAuth({
          identity: {
            userId,
            email: storedUser.email,
            sessionId,
            originConsentId: null,
            organizationId,
            authorization: {
              role: authorization.role,
              billingAccess: authorization.billingAccess,
              workspace: authorization.workspace,
              email: authorization.email,
              emailVerified: authorization.emailVerified,
              userDeleted: authorization.userDeleted,
              enrolledFeatureIds: authorization.enrolledFeatureIds,
              professionalUse: authorization.professionalUse,
            },
          },
          initialWorkspaceId: null,
          request: requestContext().request,
          server: null,
        });
        if (!viaIdentity.ok) {
          panic("The fixture identity must build a member context");
        }

        const requestCaller = viaRequest.caller;
        const identityCaller = viaIdentity.value;
        // The two contexts name the same fields, and every value that is data
        // is equal; the readers are compared by what they read.
        expect(Object.keys(identityCaller).toSorted()).toEqual(
          Object.keys(requestCaller).toSorted(),
        );
        for (const [key, value] of Object.entries(requestCaller)) {
          if (typeof value !== "function") {
            expect([key, Reflect.get(identityCaller, key)]).toEqual([
              key,
              value,
            ]);
          }
        }
        expect(await identityCaller.getAccessibleWorkspaces()).toEqual(
          await requestCaller.getAccessibleWorkspaces(),
        );
        expect(await identityCaller.getActiveWorkspaceIds()).toEqual(
          await requestCaller.getActiveWorkspaceIds(),
        );
        const ownUser = async (caller: typeof requestCaller) =>
          await caller.scopedDb(
            async (tx) =>
              await tx
                .select({ id: member.userId })
                .from(member)
                .where(eq(member.organizationId, organizationId)),
          );
        expect(await ownUser(identityCaller)).toEqual(
          await ownUser(requestCaller),
        );
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
      }
    });
  });
}

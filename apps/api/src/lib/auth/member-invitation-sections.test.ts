import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { expect, test } from "bun:test";

import type { InvitationStatus } from "@stll/auth-model/invitation-sections";

import { createMemberInvitationSectionsPlugin } from "./member-invitation-sections";

const NOW = new Date("2026-10-30T12:00:00Z");

test("the authenticated organization read omits accepted invitations and retains open and past entries", async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "invitation-sections-test-secret-long-enough",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      organization(),
      createMemberInvitationSectionsPlugin(createAuthMiddleware, () => NOW),
    ],
  });
  const signup = await auth.api.signUpEmail({
    body: {
      email: "owner@example.test",
      name: "Owner",
      password: "Invitation fixture password 123!",
    },
    asResponse: true,
  });
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";").at(0))
    .join("; ");
  const headers = new Headers({ cookie });
  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw new TypeError("Owner fixture has no session");
  }
  const org = await auth.api.createOrganization({
    headers,
    body: { name: "Test organization", slug: "invitation-sections" },
  });
  expect(org).not.toBeNull();
  if (!org) {
    throw new TypeError("Organization fixture was not created");
  }
  const context = await auth.$context;
  const statuses = [
    "pending",
    "accepted",
    "rejected",
    "canceled",
  ] as const satisfies readonly InvitationStatus[];
  for (const status of statuses) {
    for (const expired of [false, true]) {
      await context.adapter.create({
        model: "invitation",
        data: {
          email: `${status}-${expired}@example.test`,
          organizationId: org.id,
          inviterId: session.user.id,
          role: "member",
          status,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          expiresAt: new Date(
            expired ? "2026-01-08T00:00:00Z" : "2027-01-01T00:00:00Z",
          ),
        },
      });
    }
  }
  const response = await auth.handler(
    new Request(
      `http://localhost:3001/api/auth/organization/get-full-organization?organizationId=${org.id}`,
      { headers },
    ),
  );
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  expect(result).toMatchObject({
    invitations: [
      expect.objectContaining({ email: "pending-false@example.test" }),
      expect.objectContaining({ email: "pending-true@example.test" }),
      expect.objectContaining({ email: "rejected-false@example.test" }),
      expect.objectContaining({ email: "rejected-true@example.test" }),
      expect.objectContaining({ email: "canceled-false@example.test" }),
      expect.objectContaining({ email: "canceled-true@example.test" }),
    ],
  });
  expect(JSON.stringify(result)).not.toContain("accepted-");
  const unauthorized = await auth.handler(
    new Request(
      `http://localhost:3001/api/auth/organization/get-full-organization?organizationId=${org.id}`,
    ),
  );
  expect(unauthorized.status).toBe(401);
});

import { APIError } from "better-call";
import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import { createDownloadPersonalDataExport } from "@/api/handlers/account-exports/download";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { AUTH_REJECTION_BODY } from "@/api/lib/auth";
import { recordContentDeliveryReceipt } from "@/api/lib/files/content-delivery";
import { logger } from "@/api/lib/observability/logger";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import { authenticateAccountExportRequest } from "@/api/mcp/auth";
import { serveForTest } from "@/api/tests/helpers/test-server";

const EXPORT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID = brandPersistedOrganizationId(
  "44444444-4444-4444-8444-444444444444",
);
const MEMBER_ID = "55555555-5555-4555-8555-555555555555";
const ARCHIVE = "account export archive";

const tokenSession = (userId: string, scopes: string[]) =>
  Result.ok({
    userId,
    organizationId: ORGANIZATION_ID,
    memberId: MEMBER_ID,
    scopes,
    credential: { type: "oauth_client" as const, clientId: "cli" },
  });

const createDownloadRoute = (membership: { currentId: string | null }) =>
  createDownloadPersonalDataExport({
    authenticateOAuth: async (token) => {
      switch (token) {
        case "consented":
          return tokenSession(OWNER_ID, [ACCOUNT_EXPORT_SCOPES.read]);
        case "unscoped":
          return tokenSession(OWNER_ID, []);
        case "other-user":
          return tokenSession(OTHER_USER_ID, [ACCOUNT_EXPORT_SCOPES.read]);
        case "jwks-unreachable":
          return await authenticateAccountExportRequest(token, {
            verifyToken: async () => {
              throw new TypeError("fetch failed");
            },
          });
        case "bad-signature":
          return await authenticateAccountExportRequest(token, {
            verifyToken: async () => {
              throw new APIError("UNAUTHORIZED");
            },
          });
        default:
          return tokenSession(OWNER_ID, []);
      }
    },
    authenticateBrowserSession: async () => ({
      ok: false,
      answer: status(401, AUTH_REJECTION_BODY[401]),
    }),
    resolveOAuthMembership: async ({ userId, organizationId }) => {
      expect(organizationId).toBe(ORGANIZATION_ID);
      return membership.currentId === null
        ? null
        : {
            memberId: membership.currentId,
            email: `${userId}@example.test`,
            role: "member",
            workspace: null,
            emailVerified: true,
            userDeleted: false,
            enrolledFeatureIds: [],
            professionalUse: { status: "required" },
          };
    },
    recordDownload: async ({ id, userId }) => {
      if (id !== EXPORT_ID || userId !== OWNER_ID) {
        return null;
      }
      recordContentDeliveryReceipt();
      return {
        id,
        userId,
        status: "ready",
        attemptCount: 1,
        claimToken: null,
        leaseExpiresAt: null,
        objectKey: `account-exports/${OWNER_ID}/${EXPORT_ID}/archive.zip`,
        attemptObjectKeys: [],
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    },
    openObjectStream: async () => ({
      body: new Blob([ARCHIVE]).stream(),
      contentLength: ARCHIVE.length,
    }),
  });

const createRoute = (membership: { currentId: string | null }) =>
  routes(
    { "/:exportId/download": { GET: createDownloadRoute(membership) } },
    { prefix: "/me/data-exports" },
  );

describe("account export download route", () => {
  test("admits only a consented OAuth token for the archive owner", async () => {
    await using server = serveForTest(
      createHttpApp({
        routes: createRoute({ currentId: MEMBER_ID }),
        middleware: [errorBoundary],
      }),
    );
    const request = async (token?: string) =>
      await server.fetch(
        new Request(
          `http://localhost/me/data-exports/${EXPORT_ID}/download`,
          token === undefined
            ? undefined
            : { headers: { authorization: `Bearer ${token}` } },
        ),
      );

    const consented = await request("consented");
    expect(consented.status).toBe(200);
    expect(consented.headers.get("content-type")).toBe("application/zip");
    expect(await consented.text()).toBe(ARCHIVE);

    const unscoped = await request("unscoped");
    expect(unscoped.status).toBe(403);

    const badSignature = await request("bad-signature");
    expect(badSignature.status).toBe(403);

    const otherUser = await request("other-user");
    expect(otherUser.status).toBe(404);

    const unauthenticated = await request();
    expect(unauthenticated.status).toBe(401);
  });
  test.each([null, "replacement-member"])(
    "requires the token's current membership: %s",
    async (currentId) => {
      const membership: { currentId: string | null } = { currentId: MEMBER_ID };
      await using server = serveForTest(
        createHttpApp({
          routes: createRoute(membership),
          middleware: [errorBoundary],
        }),
      );
      const request = async () =>
        await server.fetch(
          new Request(
            `http://localhost/me/data-exports/${EXPORT_ID}/download`,
            { headers: { authorization: "Bearer consented" } },
          ),
        );
      expect((await request()).status).toBe(200);
      membership.currentId = currentId;
      const refused = await request();
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(AUTH_REJECTION_BODY[403]);
    },
  );

  test("reports unavailable verification keys as a server failure", async () => {
    const logged = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      await using server = serveForTest(
        createHttpApp({
          routes: createRoute({ currentId: MEMBER_ID }),
          middleware: [errorBoundary],
        }),
      );
      const response = await server.fetch(
        new Request(`http://localhost/me/data-exports/${EXPORT_ID}/download`, {
          headers: { authorization: "Bearer jwks-unreachable" },
        }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(AUTH_REJECTION_BODY[500]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        "account_export.download_verification_unavailable",
        {
          errorType: "McpTokenVerificationError",
        },
      );
    } finally {
      logged.mockRestore();
    }
  });
});

import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import { createDownloadPersonalDataExport } from "@/api/handlers/account-exports/download";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { AUTH_REJECTION_BODY } from "@/api/lib/auth";
import { recordContentDeliveryReceipt } from "@/api/lib/files/content-delivery";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

const EXPORT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVE = "account export archive";

const tokenSession = (userId: string, scopes: string[]) =>
  Result.ok({
    userId,
    organizationId: "organization",
    scopes,
    credential: { type: "oauth_client" as const, clientId: "cli" },
  });

const downloadRoute = createDownloadPersonalDataExport({
  authenticateOAuth: async (token) => {
    switch (token) {
      case "consented":
        return tokenSession(OWNER_ID, [ACCOUNT_EXPORT_SCOPES.read]);
      case "unscoped":
        return tokenSession(OWNER_ID, []);
      case "other-user":
        return tokenSession(OTHER_USER_ID, [ACCOUNT_EXPORT_SCOPES.read]);
      default:
        return tokenSession(OWNER_ID, []);
    }
  },
  authenticateBrowserSession: async () => ({
    ok: false,
    answer: status(401, AUTH_REJECTION_BODY[401]),
  }),
  resolveOAuthUser: async (userId) => ({
    id: userId,
    email: `${userId}@example.test`,
  }),
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

const route = routes(
  { "/:exportId/download": { GET: downloadRoute } },
  { prefix: "/me/data-exports" },
);

describe("account export download route", () => {
  test("admits only a consented OAuth token for the archive owner", async () => {
    await using server = serveForTest(
      createHttpApp({ routes: route, middleware: [errorBoundary] }),
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

    const otherUser = await request("other-user");
    expect(otherUser.status).toBe(404);

    const unauthenticated = await request();
    expect(unauthenticated.status).toBe(401);
  });
});

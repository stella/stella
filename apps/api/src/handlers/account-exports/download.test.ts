import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import { createDownloadPersonalDataExport } from "@/api/handlers/account-exports/download";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { AUTH_REJECTION_BODY } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
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

const createFixture = () => {
  const reads = { users: 0, downloads: 0, streams: 0 };
  const browserUsers = new Map([
    ["session=owner", OWNER_ID],
    ["session=other-user", OTHER_USER_ID],
  ]);
  const downloadRoute = createDownloadPersonalDataExport({
    authenticateOAuth: async (token) => {
      switch (token) {
        case "consented":
          return tokenSession(OWNER_ID, [ACCOUNT_EXPORT_SCOPES.read]);
        case "unscoped":
          return tokenSession(OWNER_ID, []);
        case "other-user":
          return tokenSession(OTHER_USER_ID, [ACCOUNT_EXPORT_SCOPES.read]);
        case "malformed-user":
          return tokenSession("", [ACCOUNT_EXPORT_SCOPES.read]);
        default:
          return tokenSession(OWNER_ID, []);
      }
    },
    authenticateBrowserSession: async (ctx) => {
      const userId = browserUsers.get(ctx.request.headers.get("cookie") ?? "");
      return userId === undefined
        ? { ok: false, answer: status(401, AUTH_REJECTION_BODY[401]) }
        : {
            ok: true,
            caller: {
              user: {
                id: toSafeId<"user">(userId),
                email: `${userId}@example.test`,
              },
            },
          };
    },
    resolveOAuthUser: async (userId) => {
      reads.users += 1;
      return { id: userId, email: `${userId}@example.test` };
    },
    recordDownload: async ({ id, userId }) => {
      reads.downloads += 1;
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
    openObjectStream: async () => {
      reads.streams += 1;
      return {
        body: new Blob([ARCHIVE]).stream(),
        contentLength: ARCHIVE.length,
      };
    },
  });

  const route = routes(
    { "/:exportId/download": { GET: downloadRoute } },
    { prefix: "/me/data-exports" },
  );

  return { route, reads };
};

const downloadUrl = `http://localhost/me/data-exports/${EXPORT_ID}/download`;

describe("account export download route", () => {
  test("agent bearers require person approval before resolving or reading an archive", async () => {
    const fixture = createFixture();
    await using server = serveForTest(
      createHttpApp({ routes: fixture.route, middleware: [errorBoundary] }),
    );
    for (const token of ["consented", "other-user"]) {
      const response = await server.fetch(
        new Request(downloadUrl, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "person_approval_required",
      });
    }
    const unscoped = await server.fetch(
      new Request(downloadUrl, {
        headers: { authorization: "Bearer unscoped" },
      }),
    );
    expect(unscoped.status).toBe(403);
    expect(await unscoped.json()).toEqual(AUTH_REJECTION_BODY[403]);
    const malformed = await server.fetch(
      new Request(downloadUrl, {
        headers: { authorization: "Bearer malformed-user" },
      }),
    );
    expect(malformed.status).toBe(401);
    expect(fixture.reads).toEqual({ users: 0, downloads: 0, streams: 0 });
  });

  test("human sessions download only their own archive", async () => {
    const fixture = createFixture();
    await using server = serveForTest(
      createHttpApp({ routes: fixture.route, middleware: [errorBoundary] }),
    );
    const owner = await server.fetch(
      new Request(downloadUrl, { headers: { cookie: "session=owner" } }),
    );
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-type")).toBe("application/zip");
    expect(await owner.text()).toBe(ARCHIVE);
    const otherUser = await server.fetch(
      new Request(downloadUrl, { headers: { cookie: "session=other-user" } }),
    );
    expect(otherUser.status).toBe(404);
    const anonymous = await server.fetch(new Request(downloadUrl));
    expect(anonymous.status).toBe(401);
    expect(fixture.reads).toEqual({ users: 0, downloads: 2, streams: 1 });
  });
});

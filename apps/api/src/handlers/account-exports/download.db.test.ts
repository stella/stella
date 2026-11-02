import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { createDownloadPersonalDataExport } from "@/api/handlers/account-exports/download";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { status } from "@/api/http/status";
import { AUTH_REJECTION_BODY } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { recordContentDeliveryReceipt } from "@/api/lib/files/content-delivery";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import { serveForTest } from "@/api/tests/helpers/test-server";

// timeout: Boot the shared PGlite engine and complete schema before assertions.
setDefaultTimeout(120_000);

let db: Awaited<ReturnType<typeof initAgentAuthTestDb>>;
beforeAll(async () => {
  db = await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const ARCHIVE = "account export archive";

type TokenClaims = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  memberId: string;
};

/**
 * One organization with the export owner as a member, an outside account,
 * and a download route whose token verifier answers from `tokens`. Membership
 * is read by the production resolver from the database rows below.
 */
const createFixture = async () => {
  const ownerId = mintAuthProviderId<"user">();
  const otherId = mintAuthProviderId<"user">();
  const organizationId = mintAuthProviderId<"organization">();
  const ownerMemberId = Bun.randomUUIDv7();
  const exportId = Bun.randomUUIDv7();
  await db.insert(user).values(
    [ownerId, otherId].map((id) => ({
      id,
      name: "Export account",
      email: `${id}@example.test`,
    })),
  );
  await db.insert(organization).values({
    id: organizationId,
    name: "Export organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  // A second member needs the organization's access state on record.
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  await db.insert(member).values({
    id: ownerMemberId,
    organizationId,
    userId: ownerId,
    role: "member",
    createdAt: new Date(),
  });

  const tokens = new Map<string, TokenClaims>();
  const downloads: { id: string; userId: string }[] = [];
  const route = createDownloadPersonalDataExport({
    authenticateOAuth: async (token) => {
      const claims = tokens.get(token);
      if (claims === undefined) {
        throw new Error(`Unknown test token ${token}`);
      }
      return Result.ok({
        ...claims,
        scopes: [ACCOUNT_EXPORT_SCOPES.read],
        credential: { type: "oauth_client" as const, clientId: "cli" },
      });
    },
    authenticateBrowserSession: async () => ({
      ok: false,
      answer: status(401, AUTH_REJECTION_BODY[401]),
    }),
    recordDownload: async ({ id, userId }) => {
      downloads.push({ id, userId });
      if (id !== exportId || userId !== ownerId) {
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
        objectKey: `account-exports/${ownerId}/${exportId}/archive.zip`,
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
  const server = serveForTest(
    createHttpApp({
      routes: routes(
        { "/:exportId/download": { GET: route } },
        { prefix: "/me/data-exports" },
      ),
      middleware: [errorBoundary],
    }),
  );
  const download = async (token: string) =>
    await server.fetch(
      new Request(`http://localhost/me/data-exports/${exportId}/download`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

  return {
    ownerId,
    otherId,
    organizationId,
    ownerMemberId,
    tokens,
    downloads,
    download,
    async [Symbol.asyncDispose]() {
      await server[Symbol.asyncDispose]();
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(inArray(user.id, [ownerId, otherId]));
    },
  };
};

const expectRefused = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(AUTH_REJECTION_BODY[403]);
};

describe("account export download membership (database)", () => {
  test("a current member downloads their own export", async () => {
    await using fixture = await createFixture();
    fixture.tokens.set("owner", {
      userId: fixture.ownerId,
      organizationId: fixture.organizationId,
      memberId: fixture.ownerMemberId,
    });

    const response = await fixture.download("owner");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ARCHIVE);
    expect(fixture.downloads).toHaveLength(1);
  });

  test("a former member's token no longer downloads the export", async () => {
    await using fixture = await createFixture();
    fixture.tokens.set("owner", {
      userId: fixture.ownerId,
      organizationId: fixture.organizationId,
      memberId: fixture.ownerMemberId,
    });
    expect((await fixture.download("owner")).status).toBe(200);

    await db.delete(member).where(eq(member.id, fixture.ownerMemberId));

    await expectRefused(await fixture.download("owner"));
    expect(fixture.downloads).toHaveLength(1);
  });

  test("a token from an earlier membership is refused after the account rejoins", async () => {
    await using fixture = await createFixture();
    fixture.tokens.set("owner", {
      userId: fixture.ownerId,
      organizationId: fixture.organizationId,
      memberId: fixture.ownerMemberId,
    });
    await db.delete(member).where(eq(member.id, fixture.ownerMemberId));
    await db.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId: fixture.organizationId,
      userId: fixture.ownerId,
      role: "member",
      createdAt: new Date(),
    });

    await expectRefused(await fixture.download("owner"));
    expect(fixture.downloads).toHaveLength(0);
  });

  test("a non-member cannot download another account's export", async () => {
    await using fixture = await createFixture();
    fixture.tokens.set("outsider", {
      userId: fixture.otherId,
      organizationId: fixture.organizationId,
      memberId: Bun.randomUUIDv7(),
    });

    await expectRefused(await fixture.download("outsider"));
    expect(fixture.downloads).toHaveLength(0);
  });

  test("a fellow member cannot download another account's export", async () => {
    await using fixture = await createFixture();
    const otherMemberId = Bun.randomUUIDv7();
    await db.insert(member).values({
      id: otherMemberId,
      organizationId: fixture.organizationId,
      userId: fixture.otherId,
      role: "member",
      createdAt: new Date(),
    });
    fixture.tokens.set("colleague", {
      userId: fixture.otherId,
      organizationId: fixture.organizationId,
      memberId: otherMemberId,
    });

    const response = await fixture.download("colleague");

    expect(response.status).toBe(404);
    expect(fixture.downloads).toEqual([
      { id: expect.any(String), userId: fixture.otherId },
    ]);
  });

  test("a deleted account's token no longer downloads the export", async () => {
    await using fixture = await createFixture();
    fixture.tokens.set("owner", {
      userId: fixture.ownerId,
      organizationId: fixture.organizationId,
      memberId: fixture.ownerMemberId,
    });
    await db
      .update(user)
      .set({ deletedAt: new Date() })
      .where(eq(user.id, fixture.ownerId));

    await expectRefused(await fixture.download("owner"));
    expect(fixture.downloads).toHaveLength(0);
  });
});

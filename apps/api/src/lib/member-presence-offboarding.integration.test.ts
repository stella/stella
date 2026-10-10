import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { desktopPresence } from "@/api/db/schema";
import readEndpoint from "@/api/handlers/desktop-presence/read";
import { reportDesktopPresence } from "@/api/handlers/desktop-presence/service";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;

beforeAll(
  async () => {
    fixture = await getRlsFixture();
  },
  { timeout: 30_000 },
);
afterAll(async () => {
  await releaseRlsFixture();
});

test("organization removal clears only the departing member's presence and rejoining starts unreported", async () => {
  const { testDb: db } = fixture;
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const actorUserId = mintAuthProviderId<"user">();
  const userId = mintAuthProviderId<"user">();
  const memberId = Bun.randomUUIDv7();
  const desktopId = Bun.randomUUIDv7();
  const scopedDb = async <T>(run: (tx: Transaction) => Promise<T>) =>
    await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));
  const readPresence = async () => {
    const result = await readEndpoint.handler(
      createTestHandlerContext<Parameters<typeof readEndpoint.handler>[0]>({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb,
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      }),
    );
    expect(result).not.toBeInstanceOf(ElysiaCustomStatusResponse);
    if (result instanceof ElysiaCustomStatusResponse) {
      return panic(`Expected presence success, received status ${result.code}`);
    }
    return result;
  };
  await db.insert(user).values(
    [actorUserId, userId].map((id) => ({
      id,
      name: "Presence member",
      email: `${id}@example.test`,
    })),
  );
  try {
    await db.insert(organization).values(
      [organizationId, otherOrganizationId].map((id) => ({
        id,
        name: "Presence organization",
        slug: id,
        createdAt: new Date(),
      })),
    );
    await db.insert(member).values([
      {
        id: memberId,
        organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
      {
        id: Bun.randomUUIDv7(),
        organizationId,
        userId: actorUserId,
        role: "owner",
        createdAt: new Date(),
      },
      {
        id: Bun.randomUUIDv7(),
        organizationId: otherOrganizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    ]);
    const report = {
      desktopId,
      version: "1.0.0",
      protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
    };
    await Promise.all(
      [
        { organizationId, userId },
        { organizationId, userId: actorUserId },
        { organizationId: otherOrganizationId, userId },
      ].map(
        async (owner) =>
          await reportDesktopPresence({ scopedDb, ...owner, report }),
      ),
    );
    await reportDesktopPresence({
      scopedDb,
      organizationId,
      userId,
      report: { ...report, desktopId: Bun.randomUUIDv7() },
    });
    expect((await readPresence()).type).toBe("current");
    await scopedDb(
      async (tx) =>
        await removeOrganizationMemberInTransaction(tx, {
          organizationId,
          memberId,
          userId,
          actorUserId,
        }),
    );
    expect(
      await db.$count(
        desktopPresence,
        and(
          eq(desktopPresence.organizationId, organizationId),
          eq(desktopPresence.userId, userId),
        ),
      ),
    ).toBe(0);
    expect(
      await db.$count(desktopPresence, eq(desktopPresence.userId, actorUserId)),
    ).toBe(1);
    expect(
      await db.$count(
        desktopPresence,
        eq(desktopPresence.organizationId, otherOrganizationId),
      ),
    ).toBe(1);
    await db.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    expect(await readPresence()).toEqual({ type: "none" });
    await reportDesktopPresence({ scopedDb, organizationId, userId, report });
    expect((await readPresence()).type).toBe("current");
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db
      .delete(organization)
      .where(eq(organization.id, otherOrganizationId));
    await db.delete(user).where(eq(user.id, userId));
    await db.delete(user).where(eq(user.id, actorUserId));
  }
});

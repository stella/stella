import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { API_KEY_PLUGIN_CONFIGS } from "@/api/lib/api-key-plugin-configs";
import {
  createBackgroundAuditRecorder,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createPersonalApiKey,
  listPersonalApiKeys,
  revokePersonalApiKey,
  rotatePersonalApiKey,
  updatePersonalApiKeyPolicy,
} from "@/api/lib/personal-api-key-lifecycle";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const database =
  asTestRaw<
    NonNullable<Parameters<typeof createPersonalApiKey>[0]["database"]>
  >(db);
afterAll(releaseTestDb);

const withFixture = async (
  run: (fixture: {
    own: Parameters<typeof createPersonalApiKey>[0];
    admin: Parameters<typeof createPersonalApiKey>[0];
    other: Parameters<typeof createPersonalApiKey>[0];
  }) => Promise<void>,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const ids = [
    mintAuthProviderId<"user">(),
    mintAuthProviderId<"user">(),
    mintAuthProviderId<"user">(),
  ];
  const [ownerId, adminId, otherId] = ids;
  if (!ownerId || !adminId || !otherId) {
    panic("Three fixture members are required");
  }
  await db.insert(organization).values({
    id: organizationId,
    name: "Personal key fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values(
    ids.map((id) => ({
      id,
      name: "Fixture member",
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    ids.map((id) => ({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: id,
      role: id === adminId ? "admin" : "member",
      createdAt: new Date(),
    })),
  );
  const principal = (userId: typeof ownerId) => ({
    organizationId,
    userId,
    database,
    name: "Personal key fixture",
    recordAuditEvent: createBackgroundAuditRecorder({
      organizationId,
      userId,
      workspaceId: null,
      execution: {
        performer: { type: "user", id: userId },
        trigger: { type: "system", source: "personal_key_test" },
      },
    }),
  });
  try {
    await run({
      own: principal(ownerId),
      admin: principal(adminId),
      other: principal(otherId),
    });
  } finally {
    await db.delete(apikey).where(eq(apikey.referenceId, ownerId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    for (const id of ids) {
      await db.delete(user).where(eq(user.id, id));
    }
  }
};

const requireKey = (
  result: Awaited<ReturnType<typeof createPersonalApiKey>>,
) => {
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    return panic(result.error.message);
  }
  return result.value;
};

describe("personal key persistence and receipts", () => {
  test("defaults to read scopes, one audience and 30 days; the plugin verifies the stored digest", async () => {
    await withFixture(async ({ own }) => {
      const key = requireKey(await createPersonalApiKey(own));
      expect(key.scopes).toEqual(["stella:search", "stella:read"]);
      expect(key.audience).toBe("default");
      const [stored] = await db
        .select()
        .from(apikey)
        .where(eq(apikey.id, key.id));
      if (!stored || !stored.expiresAt) {
        panic("Minted key must be persisted with an expiry");
      }
      expect(stored.key).not.toBe(key.key);
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
        30 * 86_400_000,
      );
      const auth = betterAuth({
        secret: "personal-key-test-secret-at-least-32-characters",
        baseURL: "http://localhost:3001",
        database: memoryAdapter({
          apikey: [stored],
          user: [],
          session: [],
          account: [],
          verification: [],
        }),
        plugins: [apiKey([...API_KEY_PLUGIN_CONFIGS])],
      });
      const verification = await auth.api.verifyApiKey({
        body: { configId: "machine", key: key.key },
      });
      expect(verification.valid).toBe(true);
      expect(verification.key?.metadata?.["kind"]).toBe("personal");
      expect(
        await auth.api.getSession({
          headers: new Headers({
            "x-api-key": key.key,
            authorization: `Bearer ${key.key}`,
          }),
        }),
      ).toBeNull();
      const events = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, own.organizationId),
            eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY),
          ),
        );
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(key.key);
      const lastRequest = new Date("2026-10-05T10:00:00Z");
      await db.update(apikey).set({ lastRequest }).where(eq(apikey.id, key.id));
      const page = await listPersonalApiKeys(
        { ...own, access: "own", limit: 20 },
        database,
      );
      expect(page.items.at(0)?.lastRequest).toEqual(lastRequest);
      expect(JSON.stringify(page)).not.toContain(key.key);
      expect(JSON.stringify(page)).not.toContain(stored.key);
    });
  });

  test.each([0, 91, 365])(
    "refuses an expiry of %s days without persisting a key",
    async (expiresInDays) => {
      await withFixture(async ({ own }) => {
        const result = await createPersonalApiKey({ ...own, expiresInDays });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.message).toBe("Invalid API key expiry");
        }
        expect(
          (
            await listPersonalApiKeys(
              { ...own, access: "own", limit: 20 },
              database,
            )
          ).items,
        ).toEqual([]);
      });
    },
  );

  test("only administrators change the policy; disabled policy refuses minting", async () => {
    await withFixture(async ({ own, admin }) => {
      const refused = await updatePersonalApiKeyPolicy({
        ...own,
        policy: "disabled",
      });
      expect(refused.isErr()).toBe(true);
      const updated = await updatePersonalApiKeyPolicy({
        ...admin,
        policy: "disabled",
      });
      expect(updated.isOk()).toBe(true);
      const minted = await createPersonalApiKey(own);
      expect(minted.isErr()).toBe(true);
      if (minted.isErr()) {
        expect(minted.error.status).toBe(403);
      }
      expect(
        (
          await listPersonalApiKeys(
            { ...own, access: "own", limit: 20 },
            database,
          )
        ).policy,
      ).toBe("disabled");
    });
  });

  test("five active keys allow a rotation but refuse a sixth; revoke frees a slot", async () => {
    await withFixture(async ({ own }) => {
      const keys = [];
      for (let i = 0; i < 5; i++) {
        keys.push(requireKey(await createPersonalApiKey(own)));
      }
      const first = keys.at(0);
      if (!first) {
        panic("The active limit fixture requires a key");
      }
      const refused = await createPersonalApiKey(own);
      expect(refused.isErr()).toBe(true);
      if (refused.isErr()) {
        expect(refused.error.status).toBe(409);
      }
      const replacement = requireKey(
        await rotatePersonalApiKey({ ...own, keyId: first.id }),
      );
      expect(replacement.id).not.toBe(first.id);
      const secondRotation = await rotatePersonalApiKey({
        ...own,
        keyId: first.id,
      });
      expect(secondRotation.isErr()).toBe(true);
      expect(
        (
          await revokePersonalApiKey({
            ...own,
            access: "own",
            keyId: replacement.id,
          })
        ).isOk(),
      ).toBe(true);
      requireKey(await createPersonalApiKey(own));
      const page = await listPersonalApiKeys(
        { ...own, access: "own", limit: 20 },
        database,
      );
      expect(page.items.filter((key) => key.enabled)).toHaveLength(5);
      const events = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, own.organizationId));
      expect(
        events.filter(
          (event) =>
            event.resourceType === AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY &&
            event.action === "delete",
        ),
      ).toHaveLength(2);
    });
  });

  test("another member cannot list, rotate or revoke the owner's key; an admin can revoke it", async () => {
    await withFixture(async ({ own, other, admin }) => {
      const key = requireKey(await createPersonalApiKey(own));
      expect(
        (
          await listPersonalApiKeys(
            { ...other, access: "own", limit: 20 },
            database,
          )
        ).items,
      ).toEqual([]);
      const revoke = await revokePersonalApiKey({
        ...other,
        access: "own",
        keyId: key.id,
      });
      const rotate = await rotatePersonalApiKey({ ...other, keyId: key.id });
      expect(revoke.isErr()).toBe(true);
      expect(rotate.isErr()).toBe(true);
      if (revoke.isErr()) {
        expect(revoke.error.status).toBe(404);
      }
      expect(
        (
          await revokePersonalApiKey({
            ...other,
            access: "organization",
            keyId: key.id,
          })
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await revokePersonalApiKey({
            ...admin,
            access: "organization",
            keyId: key.id,
          })
        ).isOk(),
      ).toBe(true);
      const before = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, own.organizationId));
      expect(
        (
          await revokePersonalApiKey({
            ...admin,
            access: "organization",
            keyId: key.id,
          })
        ).isOk(),
      ).toBe(true);
      const after = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, own.organizationId));
      expect(after).toHaveLength(before.length);
    });
  });

  test("audit failure rolls back creation and rotation, preserving the original credential", async () => {
    await withFixture(async ({ own }) => {
      const failure = async () => {
        throw new HandlerError({
          status: 500,
          message: "fixture audit failure",
        });
      };
      const failedCreate = await createPersonalApiKey({
        ...own,
        recordAuditEvent: failure,
      });
      expect(failedCreate.isErr()).toBe(true);
      expect(
        (
          await listPersonalApiKeys(
            { ...own, access: "own", limit: 20 },
            database,
          )
        ).items,
      ).toEqual([]);
      const key = requireKey(await createPersonalApiKey(own));
      const failedRotate = await rotatePersonalApiKey({
        ...own,
        keyId: key.id,
        recordAuditEvent: failure,
      });
      expect(failedRotate.isErr()).toBe(true);
      const page = await listPersonalApiKeys(
        { ...own, access: "own", limit: 20 },
        database,
      );
      expect(page.items).toHaveLength(1);
      expect(page.items.at(0)?.enabled).toBe(true);
    });
  });
});

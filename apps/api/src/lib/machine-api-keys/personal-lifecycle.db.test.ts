import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { memoryAdapter } from "better-auth/adapters/memory";
import { panic } from "better-result";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import Elysia from "elysia";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  account,
  apikey,
  member,
  organization,
  session,
  user,
  verification,
} from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import { auditLogs, organizationSettings } from "@/api/db/schema";
import { API_KEY_PLUGIN_CONFIGS } from "@/api/lib/api-key-plugin-configs";
import {
  createBackgroundAuditRecorder,
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log";
import { createAuthMacro } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  PERSONAL_API_KEY_AUDIENCES,
  PERSONAL_API_KEY_SCOPES,
} from "@/api/lib/machine-api-key-config";
import {
  createPersonalApiKey,
  listPersonalApiKeys,
  readPersonalApiKeyPolicy,
  revokePersonalApiKey,
  rotatePersonalApiKey,
  updatePersonalApiKeyPolicy,
} from "@/api/lib/machine-api-keys/personal-lifecycle";
import { isMemberRole } from "@/api/lib/member-roles";
import { logger } from "@/api/lib/observability/logger";
import { resolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import { McpAuthenticationError } from "@/api/mcp/errors";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { PLAIN_MEMBER_FACTS } from "@/api/tests/helpers/member-authorization";
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
    await db.delete(apikey).where(inArray(apikey.referenceId, ids));
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
  test("turning policy off disables every organization personal key with owner receipts, and turning it on never revives them", async () => {
    await withFixture(async ({ own, other, admin }) => {
      const owned = requireKey(await createPersonalApiKey(own));
      const otherKey = requireKey(await createPersonalApiKey(other));
      const ids = [owned.id, otherKey.id];
      await withFixture(async ({ own: foreign }) => {
        const foreignKey = requireKey(await createPersonalApiKey(foreign));
        expect(
          (
            await updatePersonalApiKeyPolicy({ ...admin, policy: "disabled" })
          ).isOk(),
        ).toBe(true);
        const rows = await db
          .select()
          .from(apikey)
          .where(inArray(apikey.id, ids));
        expect(rows).toHaveLength(ids.length);
        expect(rows.every((key) => !key.enabled)).toBe(true);
        const [unaffected] = await db
          .select()
          .from(apikey)
          .where(eq(apikey.id, foreignKey.id));
        expect(unaffected?.enabled).toBe(true);
        const receipts = await db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, own.organizationId),
              eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY),
              eq(auditLogs.action, AUDIT_ACTION.DELETE),
            ),
          );
        expect(receipts).toHaveLength(ids.length);
        for (const [keyId, ownerUserId] of [
          [owned.id, own.userId],
          [otherKey.id, other.userId],
        ]) {
          const receipt = receipts.find((event) => event.resourceId === keyId);
          expect(receipt?.userId).toBe(admin.userId);
          expect(receipt?.metadata).toMatchObject({ ownerUserId });
        }
        expect(
          (
            await updatePersonalApiKeyPolicy({ ...admin, policy: "enabled" })
          ).isOk(),
        ).toBe(true);
        const after = await db
          .select()
          .from(apikey)
          .where(inArray(apikey.id, ids));
        expect(after.every((key) => !key.enabled)).toBe(true);
        requireKey(await createPersonalApiKey(own));
      });
    });
  });

  test("failed policy revocation receipts roll back the setting and every affected key", async () => {
    await withFixture(async ({ own, other, admin }) => {
      const first = requireKey(await createPersonalApiKey(own));
      const second = requireKey(await createPersonalApiKey(other));
      const eventsBefore = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, own.organizationId));
      const failed = await updatePersonalApiKeyPolicy({
        ...admin,
        policy: "disabled",
        recordAuditEvent: async (tx, event) => {
          // Every revoked key's receipt is written in one batch.
          const events = Array.isArray(event) ? event : [event];
          expect(events).toHaveLength(2);
          for (const receipt of events) {
            expect(receipt).toMatchObject({
              action: AUDIT_ACTION.DELETE,
              resourceType: AUDIT_RESOURCE_TYPE.PERSONAL_API_KEY,
            });
          }
          await admin.recordAuditEvent(tx, event);
          throw new HandlerError({
            status: 500,
            message: "fixture policy revocation receipt failure",
          });
        },
      });
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) {
        expect(failed.error.message).toBe(
          "fixture policy revocation receipt failure",
        );
      }
      expect(await readPersonalApiKeyPolicy(own.organizationId, database)).toBe(
        "enabled",
      );
      const rows = await db
        .select()
        .from(apikey)
        .where(inArray(apikey.id, [first.id, second.id]));
      expect(rows).toHaveLength(2);
      expect(rows.every((key) => key.enabled)).toBe(true);
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, own.organizationId)),
      ).toEqual(eventsBefore);
    });
  });

  test("expired keys cannot be rotated into fresh credentials", async () => {
    await withFixture(async ({ own }) => {
      const key = requireKey(await createPersonalApiKey(own));
      await db
        .update(apikey)
        .set({ expiresAt: new Date("2000-01-01T00:00:00Z") })
        .where(eq(apikey.id, key.id));
      const eventsBefore = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, own.organizationId));
      const rotated = await rotatePersonalApiKey({ ...own, keyId: key.id });
      expect(rotated.isErr()).toBe(true);
      if (rotated.isErr()) {
        expect(rotated.error.status).toBe(409);
      }
      const page = await listPersonalApiKeys(
        { ...own, access: "own", limit: 20 },
        database,
      );
      expect(page.items.map((item) => item.id)).toEqual([key.id]);
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, own.organizationId)),
      ).toEqual(eventsBefore);
    });
  });

  test("invalid personal key metadata is reported and skipped while its owner can still revoke the raw row", async () => {
    await withFixture(async ({ own, other }) => {
      const healthy = requireKey(await createPersonalApiKey(own));
      const malformed = requireKey(await createPersonalApiKey(own));
      await db
        .update(apikey)
        .set({
          metadata: JSON.stringify({
            kind: "personal",
            organizationId: own.organizationId,
            audience: "invalid-audience",
            scopes: [...PERSONAL_API_KEY_SCOPES],
          }),
        })
        .where(eq(apikey.id, malformed.id));
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const page = await listPersonalApiKeys(
          { ...own, access: "own", limit: 20 },
          database,
        );
        expect(page.items.map((item) => item.id)).toEqual([healthy.id]);
        expect(warn).toHaveBeenCalledWith(
          "api_keys.stored_key_unreadable",
          expect.objectContaining({ keyId: malformed.id, column: "metadata" }),
        );
        const unauthorized = await revokePersonalApiKey({
          ...other,
          access: "own",
          keyId: malformed.id,
        });
        expect(unauthorized.isErr()).toBe(true);
        if (unauthorized.isErr()) {
          expect(unauthorized.error.status).toBe(404);
        }
        expect(
          (
            await revokePersonalApiKey({
              ...own,
              access: "own",
              keyId: malformed.id,
            })
          ).isOk(),
        ).toBe(true);
        const [row] = await db
          .select()
          .from(apikey)
          .where(eq(apikey.id, malformed.id));
        expect(row?.enabled).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });
  });
  test.each(PERSONAL_API_KEY_AUDIENCES)(
    "%s credentials stop authenticating immediately after owner or administrator revocation",
    async (audience) => {
      await withFixture(async ({ own, admin }) => {
        const auth = betterAuth({
          secret: "personal-key-test-secret-at-least-32-characters",
          baseURL: "http://localhost:3001",
          database: drizzleAdapter(asTestRaw<typeof rootDb>(db), {
            provider: "pg",
            schema: { account, apikey, session, user, verification },
          }),
          plugins: [apiKey([...API_KEY_PLUGIN_CONFIGS])],
        });
        const sessionReads = { count: 0 };
        const rest = new Elysia()
          .use(
            createAuthMacro({
              getSession: async ({ headers }) => {
                const resolved = await auth.api.getSession({
                  headers: new Headers(headers),
                  returnHeaders: true,
                });
                expect(resolved.response).toBeNull();
                if (resolved.response !== null) {
                  panic("A personal key must never create a REST session");
                }
                sessionReads.count += 1;
                return { headers: resolved.headers, response: null };
              },
            }),
          )
          .get("/protected", () => "authenticated", { validateAuth: true });
        const resolveAuthorization: NonNullable<
          Parameters<typeof resolveMachineApiKeySession>[1]
        >["resolveAuthorization"] = async ({ organizationId, userId }) => {
          const [membership] = await db
            .select({
              memberId: member.id,
              role: member.role,
              email: user.email,
            })
            .from(member)
            .innerJoin(user, eq(user.id, member.userId))
            .where(
              and(
                eq(member.organizationId, organizationId),
                eq(member.userId, userId),
              ),
            );
          if (!membership || !isMemberRole(membership.role)) {
            return null;
          }
          return {
            memberId: membership.memberId,
            role: membership.role,
            email: membership.email,
            workspace: null,
            ...PLAIN_MEMBER_FACTS,
          };
        };
        for (const access of ["own", "organization"] as const) {
          const key = requireKey(
            await createPersonalApiKey({ ...own, audience }),
          );
          const resolve = async () =>
            await resolveMachineApiKeySession(key.key, {
              mode: audience,
              verifyApiKey: auth.api.verifyApiKey,
              resolveAuthorization,
              resolvePersonalPolicy: async (organizationId) =>
                readPersonalApiKeyPolicy(organizationId, database),
            });
          const assertNoRestSession = async () => {
            for (const headers of [
              new Headers({ "x-api-key": key.key }),
              new Headers({ authorization: `Bearer ${key.key}` }),
            ]) {
              const response = await auth.handler(
                new Request("http://localhost:3001/api/auth/get-session", {
                  headers,
                }),
              );
              expect(response.status).toBe(200);
              expect(await response.json()).toBeNull();
              const readsBefore = sessionReads.count;
              const protectedResponse = await rest.handle(
                new Request("http://localhost:3001/protected", { headers }),
              );
              expect(protectedResponse.status).toBe(401);
              expect(sessionReads.count).toBe(readsBefore + 1);
            }
          };
          const authenticated = await resolve();
          expect(authenticated.userId).toBe(own.userId);
          expect(authenticated.organizationId).toBe(own.organizationId);
          expect(authenticated.credential).toMatchObject({
            type: "personal_api_key",
            id: key.id,
          });
          await assertNoRestSession();
          const revoked = await revokePersonalApiKey({
            ...(access === "own" ? own : admin),
            access,
            keyId: key.id,
          });
          expect(revoked.isOk()).toBe(true);
          expect(
            (
              await auth.api.verifyApiKey({
                body: { configId: "machine", key: key.key },
              })
            ).valid,
          ).toBe(false);
          expect(await rejectionOf(resolve())).toBeInstanceOf(
            McpAuthenticationError,
          );
          await assertNoRestSession();
        }
      });
    },
  );

  test("rotation retains the persisted permission ceiling after an owner is promoted", async () => {
    await withFixture(async ({ own }) => {
      const membership = and(
        eq(member.organizationId, own.organizationId),
        eq(member.userId, own.userId),
      );
      await db.update(member).set({ role: "intern" }).where(membership);
      const key = requireKey(
        await createPersonalApiKey({
          ...own,
          scopes: [...PERSONAL_API_KEY_SCOPES],
        }),
      );
      const [original] = await db
        .select()
        .from(apikey)
        .where(eq(apikey.id, key.id));
      if (!original?.permissions) {
        panic("The original credential must have persisted permissions");
      }
      await db.update(member).set({ role: "member" }).where(membership);
      const freshKey = requireKey(
        await createPersonalApiKey({
          ...own,
          scopes: [...PERSONAL_API_KEY_SCOPES],
        }),
      );
      const [fresh] = await db
        .select()
        .from(apikey)
        .where(eq(apikey.id, freshKey.id));
      if (!fresh?.permissions) {
        panic("The promoted owner must have persisted permissions");
      }
      expect(JSON.parse(fresh.permissions)).not.toEqual(
        JSON.parse(original.permissions),
      );
      const rotatedKey = requireKey(
        await rotatePersonalApiKey({ ...own, keyId: key.id }),
      );
      const [rotated] = await db
        .select()
        .from(apikey)
        .where(eq(apikey.id, rotatedKey.id));
      if (!rotated?.permissions) {
        panic("The rotated credential must have persisted permissions");
      }
      expect(JSON.parse(rotated.permissions)).toEqual(
        JSON.parse(original.permissions),
      );
      expect(rotated.enabled).toBe(true);
      const [revoked] = await db
        .select()
        .from(apikey)
        .where(eq(apikey.id, key.id));
      expect(revoked?.enabled).toBe(false);
    });
  });

  test("audit failure rolls back both initial and existing personal key policy settings", async () => {
    await withFixture(async ({ own, admin }) => {
      const failure = async () => {
        throw new HandlerError({
          status: 500,
          message: "fixture policy audit failure",
        });
      };
      const settingsForOrganization = eq(
        organizationSettings.organizationId,
        own.organizationId,
      );
      expect(
        await db
          .select()
          .from(organizationSettings)
          .where(settingsForOrganization),
      ).toEqual([]);
      const failedInsert = await updatePersonalApiKeyPolicy({
        ...admin,
        policy: "disabled",
        recordAuditEvent: failure,
      });
      expect(failedInsert.isErr()).toBe(true);
      if (failedInsert.isErr()) {
        expect(failedInsert.error.message).toBe("fixture policy audit failure");
      }
      expect(
        await db
          .select()
          .from(organizationSettings)
          .where(settingsForOrganization),
      ).toEqual([]);
      expect(
        (
          await updatePersonalApiKeyPolicy({ ...admin, policy: "enabled" })
        ).isOk(),
      ).toBe(true);
      const before = await db
        .select()
        .from(organizationSettings)
        .where(settingsForOrganization);
      const eventsBefore = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, own.organizationId));
      const failedUpdate = await updatePersonalApiKeyPolicy({
        ...admin,
        policy: "disabled",
        recordAuditEvent: failure,
      });
      expect(failedUpdate.isErr()).toBe(true);
      if (failedUpdate.isErr()) {
        expect(failedUpdate.error.message).toBe("fixture policy audit failure");
      }
      expect(
        await db
          .select()
          .from(organizationSettings)
          .where(settingsForOrganization),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, own.organizationId)),
      ).toEqual(eventsBefore);
      requireKey(await createPersonalApiKey(own));
    });
  });

  test("shared owners and unrelated administrators cannot cross organization key boundaries", async () => {
    await withFixture(async ({ own, admin }) => {
      const key = requireKey(await createPersonalApiKey(own));
      await withFixture(
        async ({ own: unrelatedOwner, admin: unrelatedAdmin }) => {
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: unrelatedOwner.organizationId,
            userId: own.userId,
            role: "member",
            createdAt: new Date(),
          });
          const sharedOwner = {
            ...unrelatedOwner,
            userId: own.userId,
            recordAuditEvent: createBackgroundAuditRecorder({
              organizationId: unrelatedOwner.organizationId,
              userId: own.userId,
              workspaceId: null,
              execution: {
                performer: { type: "user", id: own.userId },
                trigger: { type: "system", source: "personal_key_test" },
              },
            }),
          };
          const foreignKey = requireKey(
            await createPersonalApiKey(sharedOwner),
          );
          try {
            for (const principal of [own, sharedOwner]) {
              const expectedId =
                principal.organizationId === own.organizationId
                  ? key.id
                  : foreignKey.id;
              const page = await listPersonalApiKeys(
                { ...principal, access: "own", limit: 20 },
                database,
              );
              expect(page.items.map((item) => item.id)).toEqual([expectedId]);
            }
            for (const principal of [admin, unrelatedAdmin]) {
              const expectedId =
                principal.organizationId === own.organizationId
                  ? key.id
                  : foreignKey.id;
              const page = await listPersonalApiKeys(
                { ...principal, access: "organization", limit: 20 },
                database,
              );
              expect(page.items.map((item) => item.id)).toEqual([expectedId]);
            }
            for (const principal of [sharedOwner, unrelatedAdmin]) {
              const rotated = await rotatePersonalApiKey({
                ...principal,
                keyId: key.id,
              });
              expect(rotated.isErr()).toBe(true);
              if (rotated.isErr()) {
                expect(rotated.error.status).toBe(404);
              }
              const revoked = await revokePersonalApiKey({
                ...principal,
                keyId: key.id,
                access:
                  principal.userId === own.userId ? "own" : "organization",
              });
              expect(revoked.isErr()).toBe(true);
              if (revoked.isErr()) {
                expect(revoked.error.status).toBe(404);
              }
            }
            const page = await listPersonalApiKeys(
              { ...own, access: "own", limit: 20 },
              database,
            );
            expect(page.items.at(0)?.enabled).toBe(true);
          } finally {
            await db.delete(apikey).where(eq(apikey.id, foreignKey.id));
          }
        },
      );
    });
  });
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
      const [owner] = await db
        .select()
        .from(user)
        .where(eq(user.id, own.userId));
      if (!owner) {
        panic("The credential owner must exist for session validation");
      }
      const auth = betterAuth({
        secret: "personal-key-test-secret-at-least-32-characters",
        baseURL: "http://localhost:3001",
        database: memoryAdapter({
          apikey: [stored],
          user: [owner],
          session: [],
          account: [],
          verification: [],
        }),
        plugins: [apiKey([...API_KEY_PLUGIN_CONFIGS])],
      });
      const verifiedKey = await auth.api.verifyApiKey({
        body: { configId: "machine", key: key.key },
      });
      expect(verifiedKey.valid).toBe(true);
      expect(verifiedKey.key?.metadata?.["kind"]).toBe("personal");
      expect(
        await auth.api.getSession({
          headers: new Headers({
            "x-api-key": key.key,
            authorization: `Bearer ${key.key}`,
          }),
        }),
      ).toBeNull();
      const sessionEnabledAuth = betterAuth({
        secret: "personal-key-test-secret-at-least-32-characters",
        baseURL: "http://localhost:3001",
        database: memoryAdapter({
          apikey: [stored],
          user: [owner],
          session: [],
          account: [],
          verification: [],
        }),
        plugins: [
          apiKey(
            API_KEY_PLUGIN_CONFIGS.map((config) =>
              config.configId === stored.configId
                ? { ...config, enableSessionForAPIKeys: true }
                : config,
            ),
          ),
        ],
      });
      expect(
        (
          await sessionEnabledAuth.api.getSession({
            headers: new Headers({ "x-api-key": key.key }),
          })
        )?.user.id,
      ).toBe(own.userId);
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

  test("four active keys allow a fifth; five refuse a sixth but allow rotation", async () => {
    await withFixture(async ({ own }) => {
      const keys = [];
      for (let i = 0; i < 4; i++) {
        keys.push(requireKey(await createPersonalApiKey(own)));
      }
      expect(keys).toHaveLength(4);
      keys.push(requireKey(await createPersonalApiKey(own)));
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
      const revocation = before.find(
        (event) =>
          event.resourceId === key.id && event.action === AUDIT_ACTION.DELETE,
      );
      expect(revocation?.userId).toBe(admin.userId);
      expect(revocation?.metadata).toMatchObject({ ownerUserId: own.userId });
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

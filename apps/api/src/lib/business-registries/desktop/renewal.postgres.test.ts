import { apiKey, defaultKeyHasher } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import Elysia from "elysia";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { randomBytes } from "node:crypto";

import { sha256Base64Url } from "@stll/sha256/bun";

import {
  account,
  apikey,
  member,
  organization,
  session,
  user,
  verification,
} from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import type { TransactionOf } from "@/api/db/scoped";
import renewDesktopAccount from "@/api/handlers/desktop-registry/renew";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";

import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS,
  desktopRegistryKeyConfig,
} from "./config";
import { VerifiedDesktopDeviceProof } from "./proof";
import { ConsumedDesktopDeviceProof } from "./proof-store";
import { probeDesktopCredential, renewDesktopCredential } from "./renewal";
import { revokeDesktopRegistryCredential } from "./revocation";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;
const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY_MS = 86_400_000;
const LIFETIME_MS = 30 * DAY_MS;
const token = (digit: string) => `stella_dr_${digit.repeat(128)}`;
const CURRENT_KEY = token("1");
const SUCCESSOR_KEY = token("2");
const THIRD_KEY = token("3");

type FixtureDb = GatedTestDb | TransactionOf<GatedTestDb>;
// Production owners open their own aggregate transaction and refuse an
// enclosing one. Inside a rollback fixture they receive a runner whose
// transaction is a savepoint of the fixture, so their writes still roll back.
const ownerDb = (db: FixtureDb): Pick<GatedTestDb, "transaction"> =>
  "rollback" in db
    ? { transaction: async (run) => await db.transaction(run) }
    : db;
const seedFixture = async (db: FixtureDb, proofDb: GatedTestDb) => {
  const signingKeys = await generateKeyPair("ES256", { extractable: true });
  const deviceJwk = await exportJWK(signingKeys.publicKey);
  const deviceJkt = await calculateJwkThumbprint(deviceJwk);
  const userId = mintAuthProviderId<"user">();
  const organizationId = mintAuthProviderId<"organization">();
  const memberId = mintAuthProviderIdValue();
  const keyId = mintAuthProviderIdValue();
  await db.insert(user).values({
    id: userId,
    name: "Renewal fixture",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Renewal fixture",
    slug: organizationId,
    createdAt: NOW,
  });
  await db.insert(member).values({
    id: memberId,
    userId,
    organizationId,
    role: "member",
    createdAt: NOW,
  });
  await db.insert(apikey).values({
    id: keyId,
    configId: DESKTOP_REGISTRY_KEY_CONFIG,
    referenceId: userId,
    key: await defaultKeyHasher(CURRENT_KEY),
    enabled: true,
    rateLimitEnabled: true,
    rateLimitTimeWindow: 60_000,
    rateLimitMax: 60,
    requestCount: 0,
    expiresAt: null,
    metadata: JSON.stringify({
      purpose: DESKTOP_REGISTRY_KEY_CONFIG,
      deviceJkt,
      organizationId,
      inactivityExpiresAt: new Date(NOW.getTime() + LIFETIME_MS).toISOString(),
    }),
  });
  const recordAuditEvent = createAuditRecorder({
    organizationId,
    userId,
    workspaceId: null,
    request: new Request("https://api.example.test/v1/desktop-account/renew"),
    server: null,
  });
  return {
    keyId,
    memberId,
    userId,
    organizationId,
    recordAuditEvent,
    signingKeys,
    deviceJwk,
    deviceJkt,
    proofDb,
  };
};
type Fixture = Awaited<ReturnType<typeof seedFixture>>;
const input = (db: FixtureDb, fixture: Fixture) => ({
  db: ownerDb(db),
  keyId: fixture.keyId,
  userId: fixture.userId,
  organizationId: fixture.organizationId,
  currentKey: CURRENT_KEY,
  successorKey: SUCCESSOR_KEY,
  recordAuditEvent: fixture.recordAuditEvent,
  signingKeys: fixture.signingKeys,
  deviceJwk: fixture.deviceJwk,
  deviceJkt: fixture.deviceJkt,
  proofDb: fixture.proofDb,
  now: NOW,
});
type RenewalFixtureOptions = Omit<
  Parameters<typeof renewDesktopCredential>[0],
  "consumedProof"
> &
  Pick<Fixture, "signingKeys" | "deviceJwk" | "deviceJkt" | "proofDb"> & {
    consumedProof?: ConsumedDesktopDeviceProof;
  };
const consumeFixtureProof = async ({
  currentKey,
  keyId,
  signingKeys,
  deviceJwk,
  deviceJkt,
  proofDb,
  now = NOW,
}: RenewalFixtureOptions) => {
  const url = "https://api.example.test/v1/desktop-account/renew";
  const compact = await new SignJWT({
    htm: "POST",
    htu: url,
    iat: Math.floor(now.getTime() / 1000),
    jti: Bun.randomUUIDv7(),
    ath: sha256Base64Url(currentKey),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: deviceJwk })
    .sign(signingKeys.privateKey);
  const verified = await VerifiedDesktopDeviceProof.verify({
    request: new Request(url, { method: "POST", headers: { DPoP: compact } }),
    expectedUrl: url,
    expectedThumbprint: deviceJkt,
    binding: { type: "account", keyId, credential: currentKey },
    now,
  });
  if (verified.isErr()) {
    panic(verified.error.message);
  }
  const consumed = await ConsumedDesktopDeviceProof.claim({
    proof: verified.value,
    db: proofDb,
    now,
  });
  if (consumed.isErr()) {
    panic(consumed.error.message);
  }
  return consumed.value;
};
const renewWithProof = async (options: RenewalFixtureOptions) =>
  await renewDesktopCredential({
    ...options,
    consumedProof:
      options.consumedProof ?? (await consumeFixtureProof(options)),
  });
const cleanProofFixture = async ({ proofDb, deviceJkt }: Fixture) =>
  await proofDb
    .delete(desktopDeviceProofReplays)
    .where(eq(desktopDeviceProofReplays.jkt, deviceJkt));
const readKey = async (db: FixtureDb, keyId: string) => {
  const row = (
    await db
      .select({
        key: apikey.key,
        enabled: apikey.enabled,
        expiresAt: apikey.expiresAt,
        inactivityExpiresAt: sql<string>`${apikey.metadata}::text::jsonb ->> 'inactivityExpiresAt'`,
      })
      .from(apikey)
      .where(eq(apikey.id, keyId))
  ).at(0);
  if (!row) {
    throw new TypeError("Renewal fixture key must exist");
  }
  expect(row.expiresAt).toBeNull();
  return row;
};
const readAudit = async (db: FixtureDb, keyId: string) =>
  await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, keyId));
type RenewalResult = Awaited<ReturnType<typeof renewDesktopCredential>>;
const requireSuccess = (outcome: RenewalResult) => {
  if (outcome.isErr()) {
    panic(`Fixture renewal unexpectedly failed: ${outcome.error.message}`);
  }
  return outcome.value;
};
const expectUnauthorized = async (operation: Promise<RenewalResult>) => {
  const outcome = await operation;
  expect(outcome.isErr()).toBe(true);
  if (outcome.isErr()) {
    expect(outcome.error).toBeInstanceOf(HandlerError);
    expect(outcome.error.status).toBe(401);
  }
};
const withRollbackFixture = async (
  body: (db: TransactionOf<GatedTestDb>, fixture: Fixture) => Promise<void>,
) => {
  if (!databaseUrl) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const db = openClient().db;
    let fixture: Fixture | undefined;
    const outcome = await Result.tryPromise({
      try: async () =>
        await db.transaction(async (tx) => {
          fixture = await seedFixture(tx, openClient().db);
          await body(tx, fixture);
          tx.rollback();
        }),
      catch: (cause) => cause,
    });
    if (fixture) {
      await cleanProofFixture(fixture);
    }
    if (
      outcome.isErr() &&
      !(outcome.error instanceof TransactionRollbackError)
    ) {
      throw outcome.error;
    }
    expect(outcome.isErr()).toBe(true);
  });
};

// Sequential fixtures and their audits roll back; concurrent fixtures commit
// only while their independent database sessions exercise the competing writes.
describe.skipIf(!enabled)("desktop credential renewal (postgres)", () => {
  test("background probes preserve the digest, original deadline and audit history", async () => {
    await withRollbackFixture(async (db, fixture) => {
      const before = await readKey(db, fixture.keyId);
      for (const elapsedDays of [0, 10, 29]) {
        const observed = requireSuccess(
          await probeDesktopCredential({
            db: ownerDb(db),
            keyId: fixture.keyId,
            userId: fixture.userId,
            organizationId: fixture.organizationId,
            currentKey: CURRENT_KEY,
            now: new Date(NOW.getTime() + elapsedDays * DAY_MS),
          }),
        );
        expect(observed.expiresAt).toBe(
          new Date(NOW.getTime() + LIFETIME_MS).toISOString(),
        );
        expect(await readKey(db, fixture.keyId)).toEqual(before);
        expect(await readAudit(db, fixture.keyId)).toEqual([]);
      }
      await expectUnauthorized(
        probeDesktopCredential({
          db: ownerDb(db),
          keyId: fixture.keyId,
          userId: fixture.userId,
          organizationId: fixture.organizationId,
          currentKey: CURRENT_KEY,
          now: new Date(NOW.getTime() + LIFETIME_MS),
        }),
      );
      expect(await readKey(db, fixture.keyId)).toEqual(before);
      expect(await readAudit(db, fixture.keyId)).toEqual([]);
    });
  });

  test("rotation sets exactly thirty days from use and can outlive the original deadline", async () => {
    await withRollbackFixture(async (db, fixture) => {
      const firstUse = new Date(NOW.getTime() + 20 * DAY_MS);
      const first = requireSuccess(
        await renewWithProof({
          ...input(db, fixture),
          now: firstUse,
        }),
      );
      expect(first.expiresAt).toBe(
        new Date(firstUse.getTime() + LIFETIME_MS).toISOString(),
      );
      expect(await readKey(db, fixture.keyId)).toEqual({
        key: await defaultKeyHasher(SUCCESSOR_KEY),
        enabled: true,
        expiresAt: null,
        inactivityExpiresAt: first.expiresAt,
      });
      await expectUnauthorized(
        renewWithProof({ ...input(db, fixture), now: firstUse }),
      );
      const secondUse = new Date(NOW.getTime() + 40 * DAY_MS);
      const second = requireSuccess(
        await renewWithProof({
          ...input(db, fixture),
          currentKey: SUCCESSOR_KEY,
          successorKey: THIRD_KEY,
          now: secondUse,
        }),
      );
      expect(second.expiresAt).toBe(
        new Date(secondUse.getTime() + LIFETIME_MS).toISOString(),
      );
      expect(await readKey(db, fixture.keyId)).toEqual({
        key: await defaultKeyHasher(THIRD_KEY),
        enabled: true,
        expiresAt: null,
        inactivityExpiresAt: second.expiresAt,
      });
      expect(await readAudit(db, fixture.keyId)).toHaveLength(2);
    });
  });

  test("audit failure rolls back the successor digest, deadline and inserted audit", async () => {
    await withRollbackFixture(async (db, fixture) => {
      const before = await readKey(db, fixture.keyId);
      const now = new Date(NOW.getTime() + DAY_MS);
      const consumedProof = await consumeFixtureProof({
        ...input(db, fixture),
        now,
      });
      const outcome = await renewWithProof({
        ...input(db, fixture),
        now,
        consumedProof,
        recordAuditEvent: async (tx, event) => {
          await fixture.recordAuditEvent(tx, event);
          throw new HandlerError({
            status: 503,
            message: "Fixture renewal audit failure",
          });
        },
      });
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toMatchObject({
          status: 503,
          message: "Fixture renewal audit failure",
        });
      }
      expect(await readKey(db, fixture.keyId)).toEqual(before);
      expect(await readAudit(db, fixture.keyId)).toEqual([]);
      const replay = await ConsumedDesktopDeviceProof.claim({
        proof: consumedProof.proof,
        db: fixture.proofDb,
        now,
      });
      expect(replay.isErr()).toBe(true);
      if (replay.isErr()) {
        expect(replay.error).toMatchObject({
          status: 401,
          code: "desktop_proof_replayed",
        });
      }
      requireSuccess(
        await renewWithProof({
          ...input(db, fixture),
          now: new Date(NOW.getTime() + DAY_MS),
        }),
      );
      expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
    });
  });

  test("a generation younger than the rotation interval answers 429 without rotating or auditing", async () => {
    await withRollbackFixture(async (db, fixture) => {
      const expectTooSoon = async (operation: Promise<RenewalResult>) => {
        const outcome = await operation;
        expect(outcome.isErr()).toBe(true);
        if (outcome.isErr()) {
          expect(outcome.error.status).toBe(429);
        }
      };
      const linked = await readKey(db, fixture.keyId);
      await expectTooSoon(
        renewWithProof({
          ...input(db, fixture),
          now: new Date(NOW.getTime() + 29_999),
        }),
      );
      expect(await readKey(db, fixture.keyId)).toEqual(linked);
      expect(await readAudit(db, fixture.keyId)).toEqual([]);
      const firstUse = new Date(NOW.getTime() + DAY_MS);
      requireSuccess(
        await renewWithProof({
          ...input(db, fixture),
          now: firstUse,
        }),
      );
      const rotated = await readKey(db, fixture.keyId);
      const successor = {
        ...input(db, fixture),
        currentKey: SUCCESSOR_KEY,
        successorKey: THIRD_KEY,
      };
      await expectTooSoon(
        renewWithProof({
          ...successor,
          now: new Date(firstUse.getTime() + 29_999),
        }),
      );
      expect(await readKey(db, fixture.keyId)).toEqual(rotated);
      expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
      requireSuccess(
        await renewWithProof({
          ...successor,
          now: new Date(firstUse.getTime() + 30_000),
        }),
      );
      expect((await readKey(db, fixture.keyId)).key).toBe(
        await defaultKeyHasher(THIRD_KEY),
      );
      expect(await readAudit(db, fixture.keyId)).toHaveLength(2);
    });
  });

  test("stale expiry cleanup cannot revoke a renewed successor generation", async () => {
    await withRollbackFixture(async (db, fixture) => {
      requireSuccess(
        await renewWithProof({
          ...input(db, fixture),
          now: new Date(NOW.getTime() + 20 * DAY_MS),
        }),
      );
      await expectUnauthorized(
        probeDesktopCredential({
          db: ownerDb(db),
          keyId: fixture.keyId,
          userId: fixture.userId,
          organizationId: fixture.organizationId,
          currentKey: CURRENT_KEY,
          now: new Date(NOW.getTime() + 31 * DAY_MS),
        }),
      );
      const renewed = await readKey(db, fixture.keyId);
      await revokeDesktopRegistryCredential({
        db: ownerDb(db),
        ...fixture,
        expectedKeyHash: await defaultKeyHasher(CURRENT_KEY),
      });
      expect(await readKey(db, fixture.keyId)).toEqual(renewed);
      expect(renewed.enabled).toBe(true);
      expect(renewed.key).toBe(await defaultKeyHasher(SUCCESSOR_KEY));
      expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
      expect(
        requireSuccess(
          await probeDesktopCredential({
            db: ownerDb(db),
            keyId: fixture.keyId,
            userId: fixture.userId,
            organizationId: fixture.organizationId,
            currentKey: SUCCESSOR_KEY,
            now: new Date(NOW.getTime() + 31 * DAY_MS),
          }),
        ).expiresAt,
      ).toBe(new Date(NOW.getTime() + 50 * DAY_MS).toISOString());
    });
  });

  test("real provider verification of an old snapshot cannot delete a renewed row or revive a revoked row", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const db = openClient().db;
      const providerDb = openClient().db;
      const fixture = await db.transaction(
        async (tx) => await seedFixture(tx, openClient().db),
      );
      let captured = Promise.withResolvers<undefined>();
      let resume = Promise.withResolvers<undefined>();
      let pauseNextLookup = true;
      let observedSnapshot: unknown = null;
      const adapterFactory = drizzleAdapter(providerDb, {
        provider: "pg",
        schema: { account, apikey, session, user, verification },
      });
      const controlledAdapter = (
        ...options: Parameters<typeof adapterFactory>
      ) => {
        const adapter = adapterFactory(...options);
        const findOne: typeof adapter.findOne = async <T>(
          query: Parameters<typeof adapter.findOne>[0],
        ) => {
          const row = await adapter.findOne<T>(query);
          if (query.model === "apikey" && row && pauseNextLookup) {
            pauseNextLookup = false;
            observedSnapshot = row;
            captured.resolve(undefined);
            await resume.promise;
          }
          return row;
        };
        return { ...adapter, findOne };
      };
      const auth = betterAuth({
        secret: "desktop-provider-race-fixture-secret-at-least-32-characters",
        baseURL: "http://localhost:3001",
        database: controlledAdapter,
        plugins: [apiKey([desktopRegistryKeyConfig])],
      });
      let pending: ReturnType<typeof auth.api.verifyApiKey> | undefined;
      try {
        for (const operation of ["renew", "revoke"] as const) {
          captured = Promise.withResolvers<undefined>();
          resume = Promise.withResolvers<undefined>();
          pauseNextLookup = true;
          const currentKey =
            operation === "renew" ? CURRENT_KEY : SUCCESSOR_KEY;
          pending = auth.api.verifyApiKey({
            body: { configId: DESKTOP_REGISTRY_KEY_CONFIG, key: currentKey },
          });
          await Promise.race([
            captured.promise,
            pending.then(() =>
              panic(
                "Provider verification must pause after its database snapshot",
              ),
            ),
          ]);
          expect(observedSnapshot).toMatchObject({
            key: await defaultKeyHasher(currentKey),
            enabled: true,
            expiresAt: null,
          });
          if (operation === "renew") {
            requireSuccess(
              await renewWithProof({
                ...input(db, fixture),
                now: new Date(NOW.getTime() + DAY_MS),
              }),
            );
          } else {
            await revokeDesktopRegistryCredential({ db, ...fixture });
          }
          const committed = await readKey(db, fixture.keyId);
          resume.resolve(undefined);
          // The provider may accept its already-read snapshot; the locked owner
          // must reject that generation after either rotation or revocation.
          expect(await pending).toMatchObject({ valid: true });
          pending = undefined;
          await expectUnauthorized(
            probeDesktopCredential({
              ...fixture,
              db,
              currentKey,
              now: new Date(NOW.getTime() + DAY_MS),
            }),
          );
          expect(await readKey(db, fixture.keyId)).toEqual(committed);
          expect(committed.key).toBe(await defaultKeyHasher(SUCCESSOR_KEY));
          expect(committed.inactivityExpiresAt).toBe(
            new Date(NOW.getTime() + DAY_MS + LIFETIME_MS).toISOString(),
          );
          expect(committed.enabled).toBe(operation === "renew");
          if (operation === "renew") {
            expect(
              await auth.api.verifyApiKey({
                body: {
                  configId: DESKTOP_REGISTRY_KEY_CONFIG,
                  key: CURRENT_KEY,
                },
              }),
            ).toMatchObject({ valid: false });
            expect(
              await auth.api.verifyApiKey({
                body: {
                  configId: DESKTOP_REGISTRY_KEY_CONFIG,
                  key: SUCCESSOR_KEY,
                },
              }),
            ).toMatchObject({ valid: true });
            expect(
              requireSuccess(
                await probeDesktopCredential({
                  ...fixture,
                  db,
                  currentKey: SUCCESSOR_KEY,
                  now: new Date(NOW.getTime() + DAY_MS),
                }),
              ).expiresAt,
            ).toBe(committed.inactivityExpiresAt);
            expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
          } else {
            expect(
              await auth.api.verifyApiKey({
                body: {
                  configId: DESKTOP_REGISTRY_KEY_CONFIG,
                  key: SUCCESSOR_KEY,
                },
              }),
            ).toMatchObject({ valid: false });
            expect(await readAudit(db, fixture.keyId)).toHaveLength(2);
          }
        }
      } finally {
        resume.resolve(undefined);
        if (pending) {
          await Promise.allSettled([pending]);
        }
        await db
          .delete(auditLogs)
          .where(eq(auditLogs.resourceId, fixture.keyId));
        await db.delete(apikey).where(eq(apikey.id, fixture.keyId));
        await db.delete(member).where(eq(member.id, fixture.memberId));
        await db
          .delete(organization)
          .where(eq(organization.id, fixture.organizationId));
        await cleanProofFixture(fixture);
        await db.delete(user).where(eq(user.id, fixture.userId));
      }
    });
  }, 20_000);

  for (const competitor of ["renew", "revoke"] as const) {
    test(`competing renewal and ${competitor} serialize without stale-key revival`, async () => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const secondDb = openClient().db;
        const controlDb = openClient().db;
        const observerDb = openClient().db;
        const fixture = await db.transaction(
          async (tx) => await seedFixture(tx, openClient().db),
        );
        try {
          const firstWorker = (
            await db
              .select({ pid: sql<number>`pg_backend_pid()` })
              .from(apikey)
              .where(eq(apikey.id, fixture.keyId))
          ).at(0);
          const secondWorker = (
            await secondDb
              .select({ pid: sql<number>`pg_backend_pid()` })
              .from(apikey)
              .where(eq(apikey.id, fixture.keyId))
          ).at(0);
          if (!firstWorker || !secondWorker) {
            throw new TypeError("Both renewal workers must exist");
          }
          expect(firstWorker.pid).not.toBe(secondWorker.pid);
          let pending: PromiseSettledResult<RenewalResult | undefined>[] = [];
          let drain:
            | Promise<PromiseSettledResult<RenewalResult | undefined>[]>
            | undefined;
          try {
            await controlDb.transaction(async (tx) => {
              await tx
                .select({ id: apikey.id })
                .from(apikey)
                .where(eq(apikey.id, fixture.keyId))
                .for("update");
              const first = renewWithProof({
                ...input(db, fixture),
                now: new Date(NOW.getTime() + DAY_MS),
              });
              const second =
                competitor === "renew"
                  ? renewWithProof({
                      ...input(secondDb, fixture),
                      successorKey: THIRD_KEY,
                      now: new Date(NOW.getTime() + DAY_MS),
                    })
                  : revokeDesktopRegistryCredential({
                      db: secondDb,
                      ...fixture,
                    }).then(() => undefined);
              drain = Promise.allSettled([first, second]);
              const deadline = performance.now() + 5000;
              while (performance.now() < deadline) {
                const snapshot = (
                  await observerDb
                    .select({
                      waiting: sql<number>`(SELECT count(*)::integer FROM pg_stat_activity
                    WHERE pid IN (${firstWorker.pid}, ${secondWorker.pid})
                      AND wait_event_type = 'Lock')`,
                    })
                    .from(apikey)
                    .where(eq(apikey.id, fixture.keyId))
                ).at(0);
                if (snapshot?.waiting === 2) {
                  return;
                }
                await Bun.sleep(10);
              }
              throw new TypeError(
                "Both credential writers must wait before releasing the row lock",
              );
            });
          } finally {
            if (drain) {
              pending = await drain;
            }
          }
          expect(pending).toHaveLength(2);
          const row = await readKey(db, fixture.keyId);
          if (competitor === "renew") {
            const outcomes = pending.map((result) => {
              if (result.status === "rejected") {
                throw result.reason;
              }
              if (!result.value) {
                panic("Competing renewal must return a typed Result");
              }
              return result.value;
            });
            expect(outcomes.filter((result) => result.isOk())).toHaveLength(1);
            expect(outcomes.filter((result) => result.isErr())).toHaveLength(1);
            for (const result of outcomes) {
              if (result.isErr()) {
                expect(result.error.status).toBe(401);
              }
            }
            const successorWon =
              row.key === (await defaultKeyHasher(SUCCESSOR_KEY));
            expect(
              successorWon || row.key === (await defaultKeyHasher(THIRD_KEY)),
            ).toBe(true);
            const [winningKey, losingKey] = successorWon
              ? [SUCCESSOR_KEY, THIRD_KEY]
              : [THIRD_KEY, SUCCESSOR_KEY];
            expect(row.enabled).toBe(true);
            expect(row.inactivityExpiresAt).toBe(
              new Date(NOW.getTime() + DAY_MS + LIFETIME_MS).toISOString(),
            );
            expect(
              requireSuccess(
                await probeDesktopCredential({
                  ...fixture,
                  db,
                  currentKey: winningKey,
                  now: new Date(NOW.getTime() + DAY_MS),
                }),
              ).expiresAt,
            ).toBe(row.inactivityExpiresAt);
            await expectUnauthorized(
              probeDesktopCredential({
                ...fixture,
                db,
                currentKey: losingKey,
                now: new Date(NOW.getTime() + DAY_MS),
              }),
            );
            expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
          } else {
            const revocation = pending.at(1);
            if (!revocation) {
              panic("Revocation outcome required");
            }
            if (revocation.status === "rejected") {
              throw revocation.reason;
            }
            expect(revocation.value).toBeUndefined();
            expect(row.enabled).toBe(false);
            const renewal = pending.at(0);
            if (!renewal) {
              throw new TypeError("Renewal outcome required");
            }
            if (renewal.status === "rejected") {
              throw renewal.reason;
            }
            if (!renewal.value) {
              panic("Renewal must return a typed Result");
            }
            if (renewal.value.isOk()) {
              expect(row.key).toBe(await defaultKeyHasher(SUCCESSOR_KEY));
              expect(row.inactivityExpiresAt).toBe(
                new Date(NOW.getTime() + DAY_MS + LIFETIME_MS).toISOString(),
              );
              expect(await readAudit(db, fixture.keyId)).toHaveLength(2);
            } else {
              expect(renewal.value.error.status).toBe(401);
              expect(row.key).toBe(await defaultKeyHasher(CURRENT_KEY));
              expect(row.inactivityExpiresAt).toBe(
                new Date(NOW.getTime() + LIFETIME_MS).toISOString(),
              );
              expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
            }
            await expectUnauthorized(
              renewWithProof({
                ...input(db, fixture),
                currentKey: SUCCESSOR_KEY,
                successorKey: THIRD_KEY,
              }),
            );
          }
          await expectUnauthorized(renewWithProof(input(db, fixture)));
        } finally {
          await db
            .delete(auditLogs)
            .where(eq(auditLogs.resourceId, fixture.keyId));
          await db.delete(apikey).where(eq(apikey.id, fixture.keyId));
          await db.delete(member).where(eq(member.id, fixture.memberId));
          await db
            .delete(organization)
            .where(eq(organization.id, fixture.organizationId));
          await cleanProofFixture(fixture);
          await db.delete(user).where(eq(user.id, fixture.userId));
        }
      });
    }, 15_000);
  }
});

// Exercise account renewal through the real HTTP boundary.
describe.skipIf(!enabled)(
  "desktop renewal proof authorization boundary (postgres)",
  () => {
    for (const proofState of ["missing", "valid"] as const) {
      test(`${proofState} proof determines renewal acceptance`, async () => {
        if (!databaseUrl) {
          panic("DATABASE_URL required");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const db = openClient().db;
          const fixture = await db.transaction(
            async (tx) => await seedFixture(tx, openClient().db),
          );
          const currentKey = `${DESKTOP_REGISTRY_KEY_PREFIX}${randomBytes(64).toString("hex")}`;
          const successorKey = `${DESKTOP_REGISTRY_KEY_PREFIX}${randomBytes(64).toString("hex")}`;
          const device = await createDesktopDeviceSigner();
          try {
            await db
              .update(apikey)
              .set({
                key: await defaultKeyHasher(currentKey),
                metadata: JSON.stringify({
                  purpose: DESKTOP_REGISTRY_KEY_CONFIG,
                  organizationId: fixture.organizationId,
                  deviceJkt: device.deviceJkt,
                  inactivityExpiresAt: new Date(
                    Date.now() +
                      LIFETIME_MS -
                      (DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS + 1) * 1000,
                  ).toISOString(),
                }),
              })
              .where(eq(apikey.id, fixture.keyId));
            const before = await readKey(db, fixture.keyId);
            const app = new Elysia().post(
              "/renew",
              renewDesktopAccount.handler,
              renewDesktopAccount.config,
            );
            const unsigned = new Request("http://localhost/renew", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${currentKey}`,
              },
              body: JSON.stringify({
                type: "rotate",
                successorKey,
              }),
            });
            const signed = await device.signRequest({
              request: unsigned.clone(),
              credential: currentKey,
            });
            const request = unsigned.clone();
            if (proofState !== "missing") {
              request.headers.set(
                "DPoP",
                signed.headers.get("DPoP") ?? panic("Proof header required"),
              );
            }
            const response = await app.handle(request);
            const payload: unknown = await response.json();
            expect(response.status).toBe(proofState === "valid" ? 200 : 401);
            const after = await readKey(db, fixture.keyId);
            if (proofState === "valid") {
              expect(payload).toMatchObject({
                identity: {
                  userId: fixture.userId,
                  organizationId: fixture.organizationId,
                },
              });
              expect(after.key).toBe(await defaultKeyHasher(successorKey));
              expect(after.enabled).toBe(true);
              expect(await readAudit(db, fixture.keyId)).toHaveLength(1);
            } else {
              expect(after).toEqual(before);
              expect(await readAudit(db, fixture.keyId)).toEqual([]);
              expect(payload).toMatchObject({ code: "desktop_proof_invalid" });
            }
          } finally {
            await db
              .delete(desktopDeviceProofReplays)
              .where(eq(desktopDeviceProofReplays.jkt, device.deviceJkt));
            await cleanProofFixture(fixture);
            await db
              .delete(auditLogs)
              .where(eq(auditLogs.organizationId, fixture.organizationId));
            await db
              .delete(apikey)
              .where(eq(apikey.referenceId, fixture.userId));
            await db.delete(member).where(eq(member.userId, fixture.userId));
            await db
              .delete(organization)
              .where(eq(organization.id, fixture.organizationId));
            await db.delete(user).where(eq(user.id, fixture.userId));
          }
        });
      });
    }
  },
);

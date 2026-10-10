import { defaultKeyHasher } from "@better-auth/api-key";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

import { sha256Base64Url } from "@stll/sha256/bun";

import { verification } from "@/api/db/auth-schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { VerifiedDesktopDeviceProof } from "./proof";
import {
  ConsumedDesktopDeviceProof,
  pruneDesktopProofReceipts,
} from "./proof-store";

const databaseUrl = process.env["DATABASE_URL"];
const enabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" && Boolean(databaseUrl);
const NOW = new Date("2026-10-06T12:00:00.000Z");
const PROOF_URL = "https://api.example.test/v1/desktop-account/renew";
const CREDENTIAL = `stella_dr_${"1".repeat(128)}`;
const deviceFixture = async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const thumbprint = await calculateJwkThumbprint(jwk);
  const proof = async (
    jti = Bun.randomUUIDv7(),
    iat = NOW.getTime() / 1000,
  ) => {
    const compact = await new SignJWT({
      htm: "POST",
      htu: PROOF_URL,
      iat,
      jti,
      ath: sha256Base64Url(CREDENTIAL),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
      .sign(keys.privateKey);
    const verified = await VerifiedDesktopDeviceProof.verify({
      request: new Request(PROOF_URL, {
        method: "POST",
        headers: { DPoP: compact },
      }),
      expectedUrl: PROOF_URL,
      expectedThumbprint: thumbprint,
      binding: {
        type: "account",
        keyId: "fixture-key",
        credential: CREDENTIAL,
      },
      now: NOW,
    });
    if (verified.isErr()) {
      panic(verified.error.message);
    }
    return verified.value;
  };
  return { thumbprint, proof };
};

const withProofDatabase = async (
  body: (fixture: {
    db: Pick<GatedTestDb, "transaction">;
    secondDb: Pick<GatedTestDb, "transaction">;
    deniedDb: Pick<GatedTestDb, "transaction">;
    unavailableDb: Pick<GatedTestDb, "transaction">;
  }) => Promise<void>,
) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const root = openClient().db;
    const schema = `desktop_proof_store_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await root.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    try {
      const migration = await Bun.file(
        new URL(
          "../../../../drizzle/20261010002000_desktop_device_proof_replays/migration.sql",
          import.meta.url,
        ),
      ).text();
      await root.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('search_path', ${`${schema}, public`}, true)`,
        );
        for (const statement of migration
          .replaceAll(
            "public.desktop_device_proof_replays",
            () => `${schema}.desktop_device_proof_replays`,
          )
          .split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) {
            await tx.execute(sql.raw(statement));
          }
        }
        await tx.execute(
          sql`CREATE TABLE ${sql.identifier(schema)}.verification (LIKE public.verification INCLUDING ALL)`,
        );
        await tx.execute(
          sql`GRANT USAGE ON SCHEMA ${sql.identifier(schema)} TO stella`,
        );
        await tx.execute(
          sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ${sql.identifier(schema)}.desktop_device_proof_replays TO stella`,
        );
      });
      const scoped = (
        source: GatedTestDb,
        role?: "stella",
        searchPath = `${schema}, public`,
      ) => ({
        transaction: async <T>(
          transactionBody: Parameters<typeof source.transaction<T>>[0],
        ) =>
          await source.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('search_path', ${searchPath}, true)`,
            );
            if (role) {
              await tx.execute(sql`SET LOCAL ROLE stella`);
            }
            return await transactionBody(tx);
          }),
      });
      await body({
        db: scoped(root),
        secondDb: scoped(openClient().db),
        deniedDb: scoped(openClient().db, "stella"),
        unavailableDb: scoped(openClient().db, undefined, "pg_catalog"),
      });
    } finally {
      await root.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    }
  });
};
type ClaimResult = Awaited<ReturnType<typeof ConsumedDesktopDeviceProof.claim>>;
const expectRefusal = (result: ClaimResult, code: string) => {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ status: 401, code });
  }
};

describe.skipIf(!enabled)("desktop proof receipts (postgres)", () => {
  test("independent database sessions claim one receipt", async () => {
    await withProofDatabase(async ({ db, secondDb }) => {
      const { proof } = await deviceFixture();
      const verified = await proof();
      const outcomes = await Promise.all([
        ConsumedDesktopDeviceProof.claim({ proof: verified, db, now: NOW }),
        ConsumedDesktopDeviceProof.claim({
          proof: verified,
          db: secondDb,
          now: NOW,
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.isOk())).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.isErr())).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.isErr()) {
          expectRefusal(outcome, "desktop_proof_replayed");
        } else {
          const expected = {
            keyId: "fixture-key",
            credentialHash: await defaultKeyHasher(CREDENTIAL),
            thumbprint: verified.thumbprint,
          };
          expect(outcome.value.authorizesCredential(expected)).toBe(true);
        }
      }
      expect(
        await db.transaction(
          async (tx) => await tx.select().from(desktopDeviceProofReplays),
        ),
      ).toHaveLength(1);
    });
  });

  test("an independently committed receipt survives an outer business rollback", async () => {
    await withProofDatabase(async ({ db, secondDb }) => {
      const verified = await (await deviceFixture()).proof();
      const businessId = Bun.randomUUIDv7();
      const rolledBack = await Result.tryPromise({
        try: async () =>
          await db.transaction(async (tx) => {
            await tx.insert(verification).values({
              id: businessId,
              identifier: "fixture-business",
              value: "fixture-value",
              expiresAt: NOW,
            });
            const accepted = await ConsumedDesktopDeviceProof.claim({
              proof: verified,
              db: secondDb,
              now: NOW,
            });
            expect(accepted.isOk()).toBe(true);
            tx.rollback();
          }),
        catch: (cause) => cause,
      });
      if (rolledBack.isOk()) {
        panic("Business fixture must roll back");
      }
      expect(rolledBack.error).toBeInstanceOf(TransactionRollbackError);
      expect(
        await db.transaction(
          async (tx) =>
            await tx
              .select()
              .from(verification)
              .where(eq(verification.id, businessId)),
        ),
      ).toEqual([]);
      expectRefusal(
        await ConsumedDesktopDeviceProof.claim({
          proof: verified,
          db,
          now: NOW,
        }),
        "desktop_proof_replayed",
      );
    });
  });

  test("bounded pruning removes only expired desktop receipts and never reopens a live proof", async () => {
    await withProofDatabase(async ({ db }) => {
      const verified = await (await deviceFixture()).proof();
      expect(
        (
          await ConsumedDesktopDeviceProof.claim({
            proof: verified,
            db,
            now: NOW,
          })
        ).isOk(),
      ).toBe(true);
      const authId = Bun.randomUUIDv7();
      await db.transaction(async (tx) => {
        await tx.insert(verification).values({
          id: authId,
          identifier: "desktop-device-proof:unrelated",
          value: "fixture-value",
          expiresAt: new Date(NOW.getTime() - 1000),
        });
        await tx.insert(desktopDeviceProofReplays).values(
          Array.from({ length: 105 }, (_, index) => ({
            jkt: "expired-device",
            jti: `${index}`,
            expiresAt: new Date(NOW.getTime() - 1000),
          })),
        );
      });
      const first = await pruneDesktopProofReceipts({ db, now: NOW });
      if (first.isErr()) {
        panic(first.error.message);
      }
      expect(first.value).toBe(100);
      expect(
        await db.transaction(
          async (tx) => await tx.select().from(desktopDeviceProofReplays),
        ),
      ).toHaveLength(6);
      const second = await pruneDesktopProofReceipts({
        db,
        now: NOW,
        limit: 2,
      });
      if (second.isErr()) {
        panic(second.error.message);
      }
      expect(second.value).toBe(2);
      expect(
        await db.transaction(
          async (tx) =>
            await tx
              .select()
              .from(verification)
              .where(eq(verification.id, authId)),
        ),
      ).toHaveLength(1);
      expectRefusal(
        await ConsumedDesktopDeviceProof.claim({
          proof: verified,
          db,
          now: new Date(NOW.getTime() + 60_999),
        }),
        "desktop_proof_replayed",
      );
      expectRefusal(
        await ConsumedDesktopDeviceProof.claim({
          proof: verified,
          db,
          now: new Date(NOW.getTime() + 61_000),
        }),
        "desktop_proof_expired",
      );
      const last = await pruneDesktopProofReceipts({
        db,
        now: new Date(NOW.getTime() + 61_000),
      });
      if (last.isErr()) {
        panic(last.error.message);
      }
      expect(last.value).toBe(1);
    });
  });

  test("pruning skips locked expired receipts while preserving its bound", async () => {
    await withProofDatabase(async ({ db, secondDb }) => {
      await db.transaction(async (tx) => {
        await tx.insert(desktopDeviceProofReplays).values([
          {
            jkt: "fixture-device",
            jti: "locked",
            expiresAt: new Date(NOW.getTime() - 2000),
          },
          {
            jkt: "fixture-device",
            jti: "available",
            expiresAt: new Date(NOW.getTime() - 1000),
          },
        ]);
      });
      const locked = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const holding = db.transaction(async (tx) => {
        await tx
          .select()
          .from(desktopDeviceProofReplays)
          .where(eq(desktopDeviceProofReplays.jti, "locked"))
          .for("update");
        locked.resolve(undefined);
        await release.promise;
      });
      try {
        await Promise.race([
          locked.promise,
          holding.then(() => panic("Fixture lock must remain held")),
        ]);
        const pruned = await pruneDesktopProofReceipts({
          db: secondDb,
          now: NOW,
          limit: 1,
        });
        if (pruned.isErr()) {
          panic(pruned.error.message);
        }
        expect(pruned.value).toBe(1);
        expect(
          await secondDb.transaction(
            async (tx) =>
              await tx
                .select({ jti: desktopDeviceProofReplays.jti })
                .from(desktopDeviceProofReplays),
          ),
        ).toEqual([{ jti: "locked" }]);
      } finally {
        release.resolve(undefined);
        await holding;
      }
    });
  });

  test("proof storage and cleanup failures cannot yield account authority", async () => {
    await withProofDatabase(async ({ db, deniedDb, unavailableDb }) => {
      const verified = await (await deviceFixture()).proof();
      const deniedPrune = await pruneDesktopProofReceipts({
        db: deniedDb,
        now: NOW,
      });
      expect(deniedPrune.isOk()).toBe(true);
      if (deniedPrune.isOk()) {
        expect(deniedPrune.value).toBe(0);
      }
      for (const { inaccessible, message } of [
        {
          inaccessible: deniedDb,
          message: "Desktop account proof verification is unavailable",
        },
        {
          inaccessible: unavailableDb,
          message: "Desktop account proof cleanup is unavailable",
        },
      ]) {
        const denied = await ConsumedDesktopDeviceProof.claim({
          proof: verified,
          db: inaccessible,
          now: NOW,
        });
        expect(denied.isErr()).toBe(true);
        if (denied.isErr()) {
          expect(denied.error).toMatchObject({
            status: 503,
            message,
          });
        }
      }
      // Pruning succeeds as the table owner; the trigger fails only receipt storage.
      await db.transaction(async (tx) => {
        await tx.execute(sql`CREATE FUNCTION reject_proof_receipt() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Receipt storage unavailable'; END $$`);
        await tx.execute(sql`CREATE TRIGGER reject_proof_receipt BEFORE INSERT
          ON desktop_device_proof_replays FOR EACH ROW EXECUTE FUNCTION reject_proof_receipt()`);
      });
      const storageDenied = await ConsumedDesktopDeviceProof.claim({
        proof: verified,
        db,
        now: NOW,
      });
      expect(storageDenied.isErr()).toBe(true);
      if (storageDenied.isErr()) {
        expect(storageDenied.error).toMatchObject({
          status: 503,
          message: "Desktop account proof verification is unavailable",
        });
      }
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_proof_receipt ON desktop_device_proof_replays`,
        );
      });
      expect(
        await db.transaction(
          async (tx) => await tx.select().from(desktopDeviceProofReplays),
        ),
      ).toEqual([]);
      expect(
        (
          await ConsumedDesktopDeviceProof.claim({
            proof: verified,
            db,
            now: NOW,
          })
        ).isOk(),
      ).toBe(true);
    });
  });
});

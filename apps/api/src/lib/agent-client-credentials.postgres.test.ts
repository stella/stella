import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import {
  encryptAgentClientCredential,
  readAgentClientCredential,
} from "@/api/agent-auth/credentials";
import { agentRegistration } from "@/api/db/agent-auth-schema";
import { env } from "@/api/env";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

let priorStorageSetting = false;
beforeEach(() => {
  priorStorageSetting = env.AGENT_CLIENT_STORAGE_V1_ENABLED;
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = true;
});
afterEach(() => {
  env.AGENT_CLIENT_STORAGE_V1_ENABLED = priorStorageSetting;
});

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const credential = Buffer.alloc(32, 0x2a).toString("hex");

if (!databaseUrl || !runPostgresTests) {
  describe.skip("stored agent credentials (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("stored agent credentials (postgres)", () => {
    test("roundtrips a stored credential without rewriting the envelope", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const result = await Result.tryPromise({
          try: async () => {
            await db.transaction(async (tx) => {
              const id = Bun.randomUUIDv7();
              const encrypted = (
                await encryptAgentClientCredential(credential)
              ).unwrap();
              await tx.insert(agentRegistration).values({
                id,
                registrationType: "service_auth",
                claimTokenHash: Bun.randomUUIDv7(),
                clientId: Bun.randomUUIDv7(),
                clientSecretSink: encrypted,
                expiresAt: new Date(Date.now() + 60_000),
              });
              const rows = await tx
                .select({
                  storedCredential: agentRegistration.clientSecretSink,
                })
                .from(agentRegistration)
                .where(eq(agentRegistration.id, id));
              const storedCredential = rows.at(0)?.storedCredential;
              expect(storedCredential).toBe(encrypted);
              expect(storedCredential).not.toBe(credential);
              expect(storedCredential).toStartWith("stella-agent:v1:");
              if (storedCredential === undefined) {
                throw new Error("registration fixture was not persisted");
              }
              let upgrades = 0;
              expect(
                (
                  await readAgentClientCredential({
                    storedCredential,
                    upgrade: async () => {
                      upgrades += 1;
                      return Result.ok();
                    },
                  })
                ).unwrap(),
              ).toBe(credential);
              expect(upgrades).toBe(0);
              tx.rollback();
            });
          },
          catch: (cause) => cause,
        });
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error).toBeInstanceOf(TransactionRollbackError);
        }
      });
    });

    test("upgrades an existing row before completing its first read", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const result = await Result.tryPromise({
          try: async () => {
            await db.transaction(async (tx) => {
              const id = Bun.randomUUIDv7();
              await tx.insert(agentRegistration).values({
                id,
                registrationType: "service_auth",
                claimTokenHash: Bun.randomUUIDv7(),
                clientId: Bun.randomUUIDv7(),
                clientSecretSink: sql`${credential}`,
                expiresAt: new Date(Date.now() + 60_000),
              });
              const rows = await tx
                .select({
                  storedCredential: agentRegistration.clientSecretSink,
                })
                .from(agentRegistration)
                .where(eq(agentRegistration.id, id));
              const storedCredential = rows.at(0)?.storedCredential;
              expect(storedCredential).toBeDefined();
              if (storedCredential === undefined) {
                throw new Error("registration fixture was not persisted");
              }
              expect(credential).toBe(storedCredential);
              expect(
                (
                  await readAgentClientCredential({
                    storedCredential,
                    upgrade: async (encrypted) => {
                      await tx
                        .update(agentRegistration)
                        .set({ clientSecretSink: encrypted })
                        .where(eq(agentRegistration.id, id));
                      return Result.ok();
                    },
                  })
                ).unwrap(),
              ).toBe(credential);
              const upgradedRows = await tx
                .select({
                  storedCredential: agentRegistration.clientSecretSink,
                })
                .from(agentRegistration)
                .where(eq(agentRegistration.id, id));
              const upgraded = upgradedRows.at(0)?.storedCredential;
              expect(upgraded).not.toBe(credential);
              expect(upgraded).toStartWith("stella-agent:v1:");
              if (upgraded === undefined) {
                throw new Error("registration fixture was not persisted");
              }
              let upgrades = 0;
              expect(
                (
                  await readAgentClientCredential({
                    storedCredential: upgraded,
                    upgrade: async () => {
                      upgrades += 1;
                      return Result.ok();
                    },
                  })
                ).unwrap(),
              ).toBe(credential);
              expect(upgrades).toBe(0);
              tx.rollback();
            });
          },
          catch: (cause) => cause,
        });
        expect(Result.isError(result)).toBe(true);
        if (Result.isError(result)) {
          expect(result.error).toBeInstanceOf(TransactionRollbackError);
        }
      });
    });
  });
}

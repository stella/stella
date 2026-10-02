import { describe, expect, test } from "bun:test";
import { asc, eq, getTableName, sql } from "drizzle-orm";

import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import {
  mcpOAuthState,
  mcpUserConnections,
  sharepointConnections,
  sharepointOAuthState,
} from "@/api/db/schema";
import {
  DELETE_CONNECTED_CREDENTIALS_TABLES,
  deleteConnectedCredentialsAndOAuthState,
} from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

type Transaction = Parameters<Parameters<GatedTestDb["transaction"]>[0]>[0];
type TestTransaction = <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
type CredentialTestContext = {
  db: GatedTestDb;
  schema: string;
  transaction: TestTransaction;
};
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const withCredentialTables = async (
  connectionUrl: string,
  work: (context: CredentialTestContext) => Promise<void>,
) => {
  await withGatedTestClients(connectionUrl, async ({ openClient }) => {
    const { db } = openClient();
    const schema = `account_delete_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    try {
      for (const table of DELETE_CONNECTED_CREDENTIALS_TABLES) {
        const tableName = getTableName(table);
        await db.execute(
          sql`CREATE TABLE ${sql.identifier(schema)}.${sql.identifier(tableName)} (LIKE public.${sql.identifier(tableName)} INCLUDING ALL)`,
        );
      }
      const transaction: TestTransaction = async (fn) =>
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('search_path', ${schema}, true)`,
          );
          return await fn(tx);
        });
      await work({ db, schema, transaction });
    } finally {
      await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    }
  });
};

const insertCredentials = async ({
  organizationIds,
  transaction,
  userId,
}: {
  organizationIds: readonly [
    SafeId<"organization">,
    ...SafeId<"organization">[],
  ];
  transaction: TestTransaction;
  userId: string;
}) => {
  const connectorId = createSafeId<"mcpConnector">();
  await transaction(async (tx) => {
    for (const organizationId of organizationIds) {
      const credential = Bun.randomUUIDv7();
      await tx.insert(sharepointConnections).values({
        id: createSafeId<"sharepointConnection">(),
        organizationId,
        userId,
        accessTokenEncrypted: Buffer.from(Bun.randomUUIDv7()),
        accessTokenIv: Buffer.from(Bun.randomUUIDv7()),
        status: "connected",
      });
      await tx.insert(sharepointOAuthState).values({
        state: Bun.randomUUIDv7(),
        organizationId,
        userId,
        codeVerifier: Bun.randomUUIDv7(),
        redirectUri: "https://example.test/callback",
      });
      await tx.insert(mcpUserConnections).values({
        id: createSafeId<"mcpUserConnection">(),
        organizationId,
        connectorId,
        userId,
        status: "connected",
      });
      await tx.insert(mcpOAuthState).values({
        state: Bun.randomUUIDv7(),
        organizationId,
        connectorId,
        userId,
        codeVerifier: Bun.randomUUIDv7(),
        redirectUri: "https://example.test/callback",
        resourceUrl: "https://mcp.example.test",
        authorizationServerUrl: "https://auth.example.test",
      });
      await tx.insert(agentDelegation).values({
        id: Bun.randomUUIDv7(),
        iss: "https://issuer.example.test",
        sub: Bun.randomUUIDv7(),
        userId,
        organizationId,
      });
      await tx.insert(agentRegistration).values({
        id: Bun.randomUUIDv7(),
        registrationType: "service_auth",
        claimTokenHash: Bun.randomUUIDv7(),
        clientId: Bun.randomUUIDv7(),
        clientSecretSink: sql`${credential}`,
        boundUserId: userId,
        boundOrganizationId: organizationId,
        expiresAt: new Date(Date.now() + 60_000),
      });
    }
    const credential = Bun.randomUUIDv7();
    await tx.insert(agentRegistration).values({
      id: Bun.randomUUIDv7(),
      registrationType: "service_auth",
      claimTokenHash: Bun.randomUUIDv7(),
      clientId: Bun.randomUUIDv7(),
      clientSecretSink: sql`${credential}`,
      boundUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
  });
};

const countsForUser = async ({
  transaction,
  userId,
}: {
  transaction: TestTransaction;
  userId: string;
}) =>
  await transaction(async (tx) => ({
    mcpUserConnections: await tx
      .select()
      .from(mcpUserConnections)
      .where(eq(mcpUserConnections.userId, userId))
      .orderBy(asc(mcpUserConnections.id)),
    mcpOAuthState: await tx
      .select()
      .from(mcpOAuthState)
      .where(eq(mcpOAuthState.userId, userId))
      .orderBy(asc(mcpOAuthState.state)),
    sharepointConnections: await tx
      .select()
      .from(sharepointConnections)
      .where(eq(sharepointConnections.userId, userId))
      .orderBy(asc(sharepointConnections.id)),
    sharepointOAuthState: await tx
      .select()
      .from(sharepointOAuthState)
      .where(eq(sharepointOAuthState.userId, userId))
      .orderBy(asc(sharepointOAuthState.state)),
    agentRegistration: await tx
      .select()
      .from(agentRegistration)
      .where(eq(agentRegistration.boundUserId, userId))
      .orderBy(asc(agentRegistration.id)),
    agentDelegation: await tx
      .select()
      .from(agentDelegation)
      .where(eq(agentDelegation.userId, userId))
      .orderBy(asc(agentDelegation.id)),
  }));

if (!databaseUrl || !enabled) {
  describe.skip("account deletion credentials (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("account deletion credentials (postgres)", () => {
    test("removes credentials across organizations and retains other users", async () => {
      await withCredentialTables(databaseUrl, async ({ transaction }) => {
        const targetUserId = Bun.randomUUIDv7();
        const otherUserId = Bun.randomUUIDv7();
        const organizationIds = [
          mintAuthProviderId<"organization">(),
          mintAuthProviderId<"organization">(),
        ] as const;
        await insertCredentials({
          transaction,
          userId: targetUserId,
          organizationIds,
        });
        await insertCredentials({
          transaction,
          userId: otherUserId,
          organizationIds: [organizationIds[0]],
        });
        const otherUsersCredentials = await countsForUser({
          transaction,
          userId: otherUserId,
        });

        await transaction((tx) =>
          deleteConnectedCredentialsAndOAuthState(tx, targetUserId),
        );

        expect(
          await countsForUser({ transaction, userId: targetUserId }),
        ).toEqual({
          mcpUserConnections: [],
          mcpOAuthState: [],
          sharepointConnections: [],
          sharepointOAuthState: [],
          agentRegistration: [],
          agentDelegation: [],
        });
        expect(
          await countsForUser({ transaction, userId: otherUserId }),
        ).toEqual(otherUsersCredentials);
      });
    });

    test("can be rerun after the user's credentials are removed", async () => {
      await withCredentialTables(databaseUrl, async ({ transaction }) => {
        const userId = Bun.randomUUIDv7();
        await insertCredentials({
          transaction,
          userId,
          organizationIds: [mintAuthProviderId<"organization">()],
        });

        await transaction((tx) =>
          deleteConnectedCredentialsAndOAuthState(tx, userId),
        );
        const afterFirstRun = await countsForUser({ transaction, userId });
        await transaction((tx) =>
          deleteConnectedCredentialsAndOAuthState(tx, userId),
        );

        expect(await countsForUser({ transaction, userId })).toEqual(
          afterFirstRun,
        );
        expect(afterFirstRun).toEqual({
          mcpUserConnections: [],
          mcpOAuthState: [],
          sharepointConnections: [],
          sharepointOAuthState: [],
          agentRegistration: [],
          agentDelegation: [],
        });
      });
    });

    test("rolls back earlier deletes when a later delete fails", async () => {
      await withCredentialTables(
        databaseUrl,
        async ({ db, schema, transaction }) => {
          const userId = Bun.randomUUIDv7();
          await insertCredentials({
            transaction,
            userId,
            organizationIds: [mintAuthProviderId<"organization">()],
          });
          const credentialsBefore = await countsForUser({
            transaction,
            userId,
          });
          await db.execute(sql`
          CREATE FUNCTION ${sql.identifier(schema)}.fail_registration_delete()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'account deletion fixture failure'; END;
          $$
        `);
          await db.execute(sql`
          CREATE TRIGGER fail_registration_delete
          BEFORE DELETE ON ${sql.identifier(schema)}.agent_registration
          FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(schema)}.fail_registration_delete()
        `);

          await expect(
            transaction((tx) =>
              deleteConnectedCredentialsAndOAuthState(tx, userId),
            ),
          ).rejects.toThrow("account deletion fixture failure");

          expect(await countsForUser({ transaction, userId })).toEqual(
            credentialsBefore,
          );
        },
      );
    });
  });
}

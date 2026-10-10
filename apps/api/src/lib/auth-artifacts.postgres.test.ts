import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { getColumns, getTableName, sql } from "drizzle-orm";

import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import {
  apikey,
  member,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  session,
} from "@/api/db/auth-schema";
import {
  desktopEditHandoffs,
  desktopEditSessions,
  entities,
  entityVersions,
  properties,
  bufferObjectCleanupIntents,
  folioCollabRoomTokens,
  mcpOAuthState,
  mcpUserConnections,
  pdfSigningSessions,
  sharepointConnections,
  sharepointOAuthState,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { removeOrganizationMemberWithAuthArtifacts } from "@/api/lib/auth-artifacts";
import { createSafeId } from "@/api/lib/branded-types";
import {
  authorizeDesktopEditSessionWithDb,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

type Transaction = Parameters<Parameters<GatedTestDb["transaction"]>[0]>[0];
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const credentialTables = [
  mcpUserConnections,
  mcpOAuthState,
  sharepointConnections,
  sharepointOAuthState,
  desktopEditHandoffs,
  pdfSigningSessions,
  folioCollabRoomTokens,
];
const tables = [
  ...credentialTables,
  entities,
  entityVersions,
  properties,
  bufferObjectCleanupIntents,
  desktopEditSessions,
  workspaces,
  workspaceMembers,
  member,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  session,
  agentRegistration,
  agentDelegation,
  apikey,
];

const snapshot = async (tx: Transaction) => ({
  members: await tx.select().from(member).orderBy(member.id),
  entities: await tx.select().from(entities).orderBy(entities.id),
  versions: await tx.select().from(entityVersions).orderBy(entityVersions.id),
  properties: await tx.select().from(properties).orderBy(properties.id),
  cleanupIntents: await tx
    .select()
    .from(bufferObjectCleanupIntents)
    .orderBy(bufferObjectCleanupIntents.id),
  mcpConnections: await tx
    .select()
    .from(mcpUserConnections)
    .orderBy(mcpUserConnections.id),
  mcpStates: await tx.select().from(mcpOAuthState).orderBy(mcpOAuthState.state),
  sharepointConnections: await tx
    .select()
    .from(sharepointConnections)
    .orderBy(sharepointConnections.id),
  sharepointStates: await tx
    .select()
    .from(sharepointOAuthState)
    .orderBy(sharepointOAuthState.state),
  handoffs: await tx
    .select()
    .from(desktopEditHandoffs)
    .orderBy(desktopEditHandoffs.id),
  signing: await tx
    .select()
    .from(pdfSigningSessions)
    .orderBy(pdfSigningSessions.id),
  rooms: await tx
    .select()
    .from(folioCollabRoomTokens)
    .orderBy(folioCollabRoomTokens.id),
  desktops: await tx
    .select()
    .from(desktopEditSessions)
    .orderBy(desktopEditSessions.id),
});

if (!databaseUrl || !enabled) {
  describe.skip("organization member auth artifacts (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("organization member auth artifacts (postgres)", () => {
    test("commits scoped credential cleanup and preserves desktop checkpoints", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const schema = `member_artifacts_${Bun.randomUUIDv7().replaceAll("-", "")}`;
        await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
        try {
          for (const table of tables) {
            const name = sql.identifier(getTableName(table));
            await db.execute(
              sql`CREATE TABLE ${sql.identifier(schema)}.${name} (LIKE public.${name} INCLUDING ALL)`,
            );
            if (
              Object.values(getColumns(table)).some(
                (column) => column.name === "entity_feature_gate",
              )
            ) {
              await db.execute(
                sql`ALTER TABLE ${sql.identifier(schema)}.${name}
                  ALTER COLUMN entity_feature_gate SET DEFAULT 'open'`,
              );
            }
          }
          const transaction = async <T>(
            work: (tx: Transaction) => Promise<T>,
          ) =>
            await db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT set_config('search_path', ${schema}, true)`,
              );
              return await work(tx);
            });
          const organizationId = mintAuthProviderId<"organization">();
          const otherOrganizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const otherUserId = mintAuthProviderId<"user">();
          const workspaceId = createSafeId<"workspace">();
          const otherWorkspaceId = createSafeId<"workspace">();
          const future = new Date(Date.now() + 3_600_000);
          const cases = [
            { organizationId, userId, workspaceId },
            {
              organizationId: otherOrganizationId,
              userId,
              workspaceId: otherWorkspaceId,
            },
            { organizationId, userId: otherUserId, workspaceId },
          ].map((scope) => ({
            organizationId: scope.organizationId,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            memberId: Bun.randomUUIDv7(),
            sessionId: createSafeId<"desktopEditSession">(),
            token: Bun.randomUUIDv7(),
          }));
          const target = cases.at(0);
          if (!target) {
            panic("Missing credential fixture");
          }
          await transaction(async (tx) => {
            await tx.insert(workspaces).values([
              {
                id: workspaceId,
                organizationId,
                name: "Matter A",
                reference: "A",
              },
              {
                id: otherWorkspaceId,
                organizationId: otherOrganizationId,
                name: "Matter B",
                reference: "B",
              },
            ]);
            for (const scope of cases) {
              const connectorId = createSafeId<"mcpConnector">();
              const entityId = createSafeId<"entity">();
              const propertyId = createSafeId<"property">();
              const baseVersionId = createSafeId<"entityVersion">();
              const checkpointFileId = createSafeId<"userFile">();
              await tx.insert(entities).values({
                id: entityId,
                workspaceId: scope.workspaceId,
                name: "Draft",
                createdBy: scope.userId,
                currentVersionId: baseVersionId,
              });
              await tx.insert(properties).values({
                id: propertyId,
                workspaceId: scope.workspaceId,
                name: "File",
                status: "fresh",
                content: { version: 1, type: "file" },
                tool: { version: 1, type: "manual-input" },
              });
              await tx.insert(entityVersions).values([
                {
                  id: baseVersionId,
                  workspaceId: scope.workspaceId,
                  entityId,
                  createdBy: scope.userId,
                  versionNumber: 1,
                  description: "Initial draft",
                },
                {
                  id: createSafeId<"entityVersion">(),
                  workspaceId: scope.workspaceId,
                  entityId,
                  createdBy: scope.userId,
                  versionNumber: 2,
                  description: "Updated draft",
                  diffWordsAdded: 4,
                  diffWordsRemoved: 1,
                },
              ]);
              await tx.insert(member).values({
                id: scope.memberId,
                organizationId: scope.organizationId,
                userId: scope.userId,
                role: "owner",
                createdAt: new Date(),
              });
              await tx.insert(mcpUserConnections).values({
                id: createSafeId<"mcpUserConnection">(),
                organizationId: scope.organizationId,
                userId: scope.userId,
                connectorId,
                status: "connected",
              });
              await tx.insert(mcpOAuthState).values({
                state: Bun.randomUUIDv7(),
                organizationId: scope.organizationId,
                userId: scope.userId,
                connectorId,
                codeVerifier: "verifier",
                redirectUri: "https://example.test/callback",
                resourceUrl: "https://example.test",
                authorizationServerUrl: "https://example.test",
              });
              await tx.insert(sharepointConnections).values({
                id: createSafeId<"sharepointConnection">(),
                organizationId: scope.organizationId,
                userId: scope.userId,
                accessTokenEncrypted: Buffer.from("ciphertext"),
                accessTokenIv: Buffer.from("iv"),
                status: "connected",
              });
              await tx.insert(sharepointOAuthState).values({
                state: Bun.randomUUIDv7(),
                organizationId: scope.organizationId,
                userId: scope.userId,
                codeVerifier: "verifier",
                redirectUri: "https://example.test/callback",
              });
              await tx.insert(desktopEditHandoffs).values({
                id: createSafeId<"desktopEditHandoff">(),
                workspaceId: scope.workspaceId,
                entityId,
                propertyId,
                createdBy: scope.userId,
                tokenHash: hashDesktopEditSessionToken(Bun.randomUUIDv7()),
                apiBaseUrl: "https://example.test",
                expiresAt: future,
              });
              await tx.insert(pdfSigningSessions).values({
                id: createSafeId<"pdfSigningSession">(),
                workspaceId: scope.workspaceId,
                entityId,
                propertyId,
                baseVersionId,
                createdBy: scope.userId,
                handoffTokenHash: hashDesktopEditSessionToken(
                  Bun.randomUUIDv7(),
                ),
                handoffExpiresAt: future,
                tokenExpiresAt: future,
              });
              await tx.insert(folioCollabRoomTokens).values({
                id: createSafeId<"folioCollabRoomToken">(),
                workspaceId: scope.workspaceId,
                roomId: createSafeId<"folioCollabRoom">(),
                userId: scope.userId,
                tokenHash: hashDesktopEditSessionToken(Bun.randomUUIDv7()),
                generation: 0,
                permissions: { canEdit: true },
                expiresAt: future,
              });
              await tx.insert(desktopEditSessions).values({
                id: scope.sessionId,
                workspaceId: scope.workspaceId,
                entityId,
                propertyId,
                baseVersionId,
                createdBy: scope.userId,
                fileType: "docx",
                fileName: "Draft.docx",
                checkpointFileId,
                checkpointSha256Hex: "a".repeat(64),
                checkpointSizeBytes: 123,
                checkpointUpdatedAt: new Date(),
                sessionTokenHash: hashDesktopEditSessionToken(scope.token),
                tokenExpiresAt: future,
              });
            }
          });
          const before = await transaction(snapshot);
          expect(before.members.some((row) => row.id === target.memberId)).toBe(
            true,
          );
          for (const scope of cases) {
            expect(
              await transaction(
                async (tx) =>
                  (
                    await authorizeDesktopEditSessionWithDb(
                      {
                        sessionId: scope.sessionId,
                        sessionToken: scope.token,
                      },
                      tx,
                    )
                  ).status,
              ),
            ).toBe("authorized");
          }
          await transaction(async (tx) => {
            await tx.execute(
              sql`CREATE FUNCTION ${sql.identifier(schema)}.reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cleanup transaction interrupted'; END; $$`,
            );
            await tx.execute(
              sql`CREATE TRIGGER reject_cleanup BEFORE UPDATE ON ${apikey} FOR EACH STATEMENT EXECUTE FUNCTION ${sql.identifier(schema)}.reject_cleanup()`,
            );
          });
          const interrupted = await Result.tryPromise({
            try: async () =>
              await transaction(async (tx) => {
                await removeOrganizationMemberWithAuthArtifacts(tx, {
                  memberId: target.memberId,
                  organizationId,
                  userId,
                });
              }),
            catch: (cause) => cause,
          });
          expect(Result.isError(interrupted)).toBe(true);
          if (Result.isError(interrupted)) {
            const messages: string[] = [];
            let cause = interrupted.error;
            while (cause instanceof Error) {
              messages.push(cause.message);
              cause = cause.cause;
            }
            expect(messages.join("\n")).toContain(
              "cleanup transaction interrupted",
            );
          }
          expect(await transaction(snapshot)).toEqual(before);
          await transaction(async (tx) => {
            await tx.execute(sql`DROP TRIGGER reject_cleanup ON ${apikey}`);
          });
          await transaction(async (tx) => {
            await removeOrganizationMemberWithAuthArtifacts(tx, {
              memberId: target.memberId,
              organizationId,
              userId,
            });
          });
          const after = await transaction(snapshot);
          expect(after.members.some((row) => row.id === target.memberId)).toBe(
            false,
          );
          expect(after.members).toEqual(
            before.members.filter((row) => row.id !== target.memberId),
          );
          expect(before.entities).toHaveLength(cases.length);
          expect(before.versions).toHaveLength(cases.length * 2);
          expect(before.properties).toHaveLength(cases.length);
          expect(before.cleanupIntents).toHaveLength(0);
          expect(after.entities).toEqual(before.entities);
          expect(after.versions).toEqual(before.versions);
          expect(after.properties).toEqual(before.properties);
          expect(after.cleanupIntents).toEqual(before.cleanupIntents);
          expect(after.mcpConnections).toEqual(
            before.mcpConnections.filter(
              (row) =>
                row.organizationId !== organizationId || row.userId !== userId,
            ),
          );
          expect(after.mcpStates).toEqual(
            before.mcpStates.filter(
              (row) =>
                row.organizationId !== organizationId || row.userId !== userId,
            ),
          );
          expect(after.sharepointConnections).toEqual(
            before.sharepointConnections.filter(
              (row) =>
                row.organizationId !== organizationId || row.userId !== userId,
            ),
          );
          expect(after.sharepointStates).toEqual(
            before.sharepointStates.filter(
              (row) =>
                row.organizationId !== organizationId || row.userId !== userId,
            ),
          );
          expect(after.handoffs).toEqual(
            before.handoffs.filter(
              (row) =>
                row.workspaceId !== workspaceId || row.createdBy !== userId,
            ),
          );
          expect(after.signing).toEqual(
            before.signing.filter(
              (row) =>
                row.workspaceId !== workspaceId || row.createdBy !== userId,
            ),
          );
          expect(after.rooms).toEqual(
            before.rooms.filter(
              (row) => row.workspaceId !== workspaceId || row.userId !== userId,
            ),
          );
          expect(after.desktops).toHaveLength(before.desktops.length);
          for (const row of before.desktops) {
            const current = after.desktops.find(
              (candidate) => candidate.id === row.id,
            );
            expect(current).toBeDefined();
            if (!current) {
              panic("Missing desktop fixture");
            }
            if (row.id !== target.sessionId) {
              expect(current).toEqual(row);
              continue;
            }
            expect(current.status).toBe("expired");
            expect(current.closedAt).toBeInstanceOf(Date);
            if (current.closedAt === null) {
              panic("Missing desktop close time");
            }
            expect(current.tokenExpiresAt).toEqual(current.closedAt);
            expect(current.tokenExpiresAt.getTime()).toBeLessThan(
              future.getTime(),
            );
            expect({
              ...current,
              status: row.status,
              closedAt: row.closedAt,
              tokenExpiresAt: row.tokenExpiresAt,
              updatedAt: row.updatedAt,
            }).toEqual(row);
          }
          expect(
            await transaction(
              async (tx) =>
                (
                  await authorizeDesktopEditSessionWithDb(
                    {
                      sessionId: target.sessionId,
                      sessionToken: target.token,
                    },
                    tx,
                  )
                ).status,
            ),
          ).toBe("missing");
          for (const scope of cases.slice(1)) {
            expect(
              await transaction(
                async (tx) =>
                  (
                    await authorizeDesktopEditSessionWithDb(
                      {
                        sessionId: scope.sessionId,
                        sessionToken: scope.token,
                      },
                      tx,
                    )
                  ).status,
              ),
            ).toBe("authorized");
          }
          await transaction(async (tx) => {
            await removeOrganizationMemberWithAuthArtifacts(tx, {
              memberId: target.memberId,
              organizationId,
              userId,
            });
          });
          expect(await transaction(snapshot)).toEqual(after);
        } finally {
          await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
        }
      });
    });
  });
}

/**
 * A delayed member's version write locks its current authority before the
 * version writer's document and matter locks, in the member → assignment →
 * matter order access changes take. A revocation holding the member row
 * therefore finds the matter and document unlocked, and the write that waited
 * for it is refused.
 */

import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { requireCurrentActiveWorkspaceMemberPermission } from "@/api/lib/db/member-authority";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import { writeFileVersion } from "./write-file-version";

// timeout: three PostgreSQL sessions race a version write through a lock barrier.
setDefaultTimeout(60_000);

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;
const pidColumns = { pid: sql<number>`pg_backend_pid()` };
const identity = sql`(SELECT 1) AS backend_identity`;
const backendPid = (rows: { pid: number }[]) =>
  rows.at(0)?.pid ?? panic("Backend identity missing");

describe.skipIf(!runPostgresTests)("delayed version authority", () => {
  test("a delayed write authorizes before its matter locks, and a revocation refuses it", async () => {
    await withGatedTestClients(
      databaseUrl ?? panic("DATABASE_URL required"),
      async ({ openClient }) => {
        const setup = openClient({ max: 1 });
        const publisher = openClient({ max: 1 });
        const revoker = openClient({ max: 1 });
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const memberId = Bun.randomUUIDv7();
        const workspaceId = createSafeId<"workspace">();
        const entityId = createSafeId<"entity">();
        const versionId = createSafeId<"entityVersion">();
        const propertyId = createSafeId<"property">();
        try {
          await setup.db.insert(organization).values({
            id: organizationId,
            name: "Version authority",
            slug: organizationId,
            createdAt: new Date(),
          });
          await setup.db.insert(user).values({
            id: userId,
            name: "Delayed requester",
            email: `${userId}@example.test`,
          });
          await setup.db.insert(member).values({
            id: memberId,
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          });
          await setup.db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Version authority matter",
            reference: workspaceId,
          });
          await setup.db
            .insert(workspaceMembers)
            .values({ workspaceId, userId });
          await setup.db.insert(entities).values({
            id: entityId,
            workspaceId,
            name: "Agreement",
            kind: "document",
          });
          await setup.db
            .insert(entityVersions)
            .values({ id: versionId, entityId, workspaceId, versionNumber: 1 });
          await setup.db
            .update(entities)
            .set({ currentVersionId: versionId })
            .where(eq(entities.id, entityId));
          await setup.db.insert(properties).values({
            id: propertyId,
            workspaceId,
            name: "File",
            content: { type: "file", version: 1 },
            tool: { type: "manual-input", version: 1 },
            status: "fresh",
            system: true,
            kinds: ["document"],
          });
          await setup.db.insert(fields).values({
            id: createSafeId<"field">(),
            workspaceId,
            entityVersionId: versionId,
            propertyId,
            content: {
              type: "file",
              version: 1,
              id: allocateFileObject(),
              fileName: "agreement.docx",
              mimeType: DOCX_MIME_TYPE,
              sizeBytes: 10,
              sha256Hex: "a".repeat(64),
              encrypted: false,
              pdfFileId: null,
            },
          });

          const publisherScopedDb = createScopedDb(
            markRlsDatabase(publisher.db),
            [workspaceId],
            organizationId,
            userId,
          );
          // The version writer itself: it owns the authority recheck.
          const writeVersion = async (
            authorize: (tx: Transaction) => Promise<void>,
          ) =>
            await Result.tryPromise(
              async () =>
                await publisherScopedDb(
                  async (tx) =>
                    await writeFileVersion({
                      authority: { type: "current-member", authorize },
                      tx: asTestRaw<Transaction>(tx),
                      organizationId,
                      workspaceId,
                      entityId,
                      userId,
                      recordAuditEvent: async () => undefined,
                      entityVersionId: createSafeId<"entityVersion">(),
                      fieldId: createSafeId<"field">(),
                      fileId: allocateFileObject(),
                      fileName: "agreement.docx",
                      mimeType: DOCX_MIME_TYPE,
                      encryption: serverBuiltFileEncryption(),
                      sizeBytes: 14,
                      sha256Hex: "b".repeat(64),
                      source: null,
                      writePolicy: { type: "replace-current-file" },
                    }),
                ),
            );
          const holdAuthority = async (tx: Transaction) => {
            await requireCurrentActiveWorkspaceMemberPermission({
              db: tx,
              organizationId,
              userId,
              workspaceId,
              permissions: { entity: ["create"] },
            });
          };
          const currentVersion = async () =>
            (
              await setup.db
                .select({ currentVersionId: entities.currentVersionId })
                .from(entities)
                .where(eq(entities.id, entityId))
            ).at(0)?.currentVersionId;

          // Paused inside its authorization, the writer holds the member row
          // and neither the matter nor the document: a writer that took them
          // first would make these NOWAIT locks fail.
          const authorized = Promise.withResolvers<undefined>();
          const resume = Promise.withResolvers<undefined>();
          const pausedWrite = writeVersion(async (tx) => {
            await holdAuthority(tx);
            authorized.resolve(undefined);
            await resume.promise;
          });
          try {
            const paused = await Promise.race([
              authorized.promise.then(() => true),
              pausedWrite.then(() => false),
            ]);
            if (!paused) {
              panic("The write finished before its authorization paused");
            }
            await revoker.db.transaction(async (tx) => {
              await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
                .for("update", { noWait: true });
              await tx
                .select({ id: entities.id })
                .from(entities)
                .where(eq(entities.id, entityId))
                .for("update", { noWait: true });
            });
            const memberLock = await Result.tryPromise(
              async () =>
                await revoker.db
                  .select({ id: member.id })
                  .from(member)
                  .where(eq(member.id, memberId))
                  .for("no key update", { noWait: true }),
            );
            expect(Result.isError(memberLock)).toBe(true);
          } finally {
            resume.resolve(undefined);
          }
          const pausedOutcome = await pausedWrite;
          expect(Result.isOk(pausedOutcome) && pausedOutcome.value.status).toBe(
            "ok",
          );
          const currentBefore = await currentVersion();
          expect(currentBefore).not.toBe(versionId);

          const publisherPid = backendPid(
            await publisher.db.select(pidColumns).from(identity),
          );
          const revokerHolds = Promise.withResolvers<number>();
          const revoked = Promise.withResolvers<undefined>();
          const releaseRevoker = Promise.withResolvers<undefined>();
          // The access change: member row first, then the matter it guards.
          const revocation = revoker.db.transaction(async (tx) => {
            await tx
              .select({ id: member.id })
              .from(member)
              .where(eq(member.id, memberId))
              .for("no key update");
            revokerHolds.resolve(
              backendPid(await tx.select(pidColumns).from(identity)),
            );
            await releaseRevoker.promise;
            // The publisher waits on the member row, holding no matter or
            // document lock, so these never wait on it.
            await tx
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .for("update", { noWait: true });
            await tx
              .select({ id: entities.id })
              .from(entities)
              .where(
                and(
                  eq(entities.id, entityId),
                  eq(entities.workspaceId, workspaceId),
                ),
              )
              .for("update", { noWait: true });
            await tx
              .update(member)
              .set({ role: "external" })
              .where(eq(member.id, memberId));
            revoked.resolve(undefined);
          });
          const revokerPid = await revokerHolds.promise;

          const published = writeVersion(holdAuthority);
          try {
            await waitForBlockedPid(setup.sql, {
              waitingPid: publisherPid,
              holdingPid: revokerPid,
            });
          } finally {
            releaseRevoker.resolve(undefined);
          }
          await revocation;
          await revoked.promise;
          const outcome = await published;

          expect(Result.isError(outcome)).toBe(true);
          expect(await currentVersion()).toBe(currentBefore);
        } finally {
          await setup.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await setup.db.delete(user).where(eq(user.id, userId));
        }
      },
    );
  });
});

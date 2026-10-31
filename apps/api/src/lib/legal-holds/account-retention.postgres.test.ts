import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/node";

import { organization, user } from "@/api/db/auth-schema";
import {
  accountDeletionRequests,
  aiMemories,
  chatThreads,
  legalHolds,
  userFiles,
  workspaces,
} from "@/api/db/schema";
import {
  deleteChatThreadsAndFileLinks,
  deletePersonalAiMemories,
  deleteUserFiles,
  recordAccountDeletionRequest,
} from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { createUserFileKey } from "@/api/lib/file-key";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { heldMatterIdsForAccount } from "./holds";

const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "account erasure under legal hold (postgres)",
  () => {
    test("retains only held-matter content after membership ends and reports the legal-claims exception", async () => {
      if (!databaseUrl) {
        throw new TypeError("DATABASE_URL is required for Postgres tests");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const workspaceId = createSafeId<"workspace">();
        const heldThreadId = createSafeId<"chatThread">();
        const privateThreadId = createSafeId<"chatThread">();
        const heldFileId = createSafeId<"userFile">();
        const privateFileId = createSafeId<"userFile">();
        const heldMemoryId = createSafeId<"aiMemory">();
        const privateMemoryId = createSafeId<"aiMemory">();
        const deletionRequestId = createSafeId<"accountDeletionRequest">();
        const heldKey = createUserFileKey({
          organizationId,
          fileId: heldFileId,
          mimeType: "application/pdf",
        });
        const privateKey = createUserFileKey({
          organizationId,
          fileId: privateFileId,
          mimeType: "application/pdf",
        });
        try {
          await db.insert(user).values({
            id: userId,
            name: "Erasure fixture",
            email: `${userId}@hold.test`,
          });
          await db.insert(organization).values({
            id: organizationId,
            name: "Retention fixture",
            slug: organizationId,
            createdAt: new Date(),
          });
          await db.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Held matter",
            reference: "RETENTION-1",
          });
          await db.insert(legalHolds).values({
            id: createSafeId<"legalHold">(),
            organizationId,
            scopeType: "matter",
            workspaceId,
            placedBy: userId,
            reason: "Preserve matter evidence",
          });
          await db.insert(chatThreads).values([
            {
              id: heldThreadId,
              organizationId,
              userId,
              title: "Matter content",
              dataWorkspaceIds: [workspaceId],
            },
            {
              id: privateThreadId,
              organizationId,
              userId,
              title: "Personal content",
            },
          ]);
          await db.insert(userFiles).values([
            {
              id: heldFileId,
              userId,
              fileName: "held.pdf",
              mimeType: "application/pdf",
              sizeBytes: 10,
              sha256Hex: sha256Hex("held"),
              s3Key: heldKey,
              threadId: heldThreadId,
            },
            {
              id: privateFileId,
              userId,
              fileName: "private.pdf",
              mimeType: "application/pdf",
              sizeBytes: 10,
              sha256Hex: sha256Hex("private"),
              s3Key: privateKey,
              threadId: privateThreadId,
            },
          ]);
          await db.insert(aiMemories).values([
            {
              id: heldMemoryId,
              organizationId,
              userId,
              createdBy: userId,
              scope: "user",
              kind: "fact",
              content: "Held evidence",
              source: "user",
              dedupKey: sha256Hex(heldMemoryId),
              sourceDataWorkspaceIds: [workspaceId],
            },
            {
              id: privateMemoryId,
              organizationId,
              userId,
              createdBy: userId,
              scope: "user",
              kind: "preference",
              content: "Personal preference",
              source: "user",
              dedupKey: sha256Hex(privateMemoryId),
            },
          ]);
          const s3KeysToDelete: string[] = [];
          await db.transaction(async (tx) => {
            const retainedWorkspaceIds = await heldMatterIdsForAccount({
              tx,
              organizationIds: [],
              userId,
            });
            expect(retainedWorkspaceIds).toEqual([workspaceId]);
            await deleteUserFiles({
              tx,
              currentUserId: userId,
              retainedWorkspaceIds,
              s3KeysToDelete,
            });
            await deleteChatThreadsAndFileLinks({
              tx,
              currentUserId: userId,
              retainedWorkspaceIds,
            });
            await deletePersonalAiMemories({
              tx,
              currentUserId: userId,
              retainedWorkspaceIds,
            });
            await recordAccountDeletionRequest({
              tx,
              deletionRequestId,
              currentUserId: userId,
              organizationIds: [],
              workspaceIds: [],
              retainedWorkspaceIds,
              s3KeysToDelete,
              taskReassignmentCount: 0,
            });
          });
          expect(s3KeysToDelete).toEqual([privateKey]);
          expect(
            await db
              .select({ id: userFiles.id })
              .from(userFiles)
              .where(inArray(userFiles.id, [heldFileId, privateFileId])),
          ).toEqual([{ id: heldFileId }]);
          expect(
            await db
              .select({ id: chatThreads.id })
              .from(chatThreads)
              .where(inArray(chatThreads.id, [heldThreadId, privateThreadId])),
          ).toEqual([{ id: heldThreadId }]);
          expect(
            await db
              .select({ id: aiMemories.id })
              .from(aiMemories)
              .where(inArray(aiMemories.id, [heldMemoryId, privateMemoryId])),
          ).toEqual([{ id: heldMemoryId }]);
          const report = await db
            .select({ erasureReport: accountDeletionRequests.erasureReport })
            .from(accountDeletionRequests)
            .where(eq(accountDeletionRequests.id, deletionRequestId));
          expect(report).toEqual([
            {
              erasureReport: {
                retainedMatterContent: [
                  {
                    workspaceId,
                    reason: "establishment_or_defence_of_legal_claims",
                  },
                ],
              },
            },
          ]);
        } finally {
          await db
            .delete(accountDeletionRequests)
            .where(eq(accountDeletionRequests.id, deletionRequestId));
          await db.delete(userFiles).where(eq(userFiles.userId, userId));
          await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
          await db
            .delete(legalHolds)
            .where(eq(legalHolds.organizationId, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  },
);

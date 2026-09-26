import { panic, Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { CORRESPONDENCE_MAX_ATTACHMENTS } from "@stll/api-contract/correspondence";

import { user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAllowedSenders,
  correspondenceAttachments,
  correspondenceFilers,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { readCorrespondenceProvenance } from "@/api/lib/correspondence/provenance";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MAX_FILERS_PER_RECORD = 10_000;
const filerUser = alias(user, "correspondence_filer_user");
const approverUser = alias(user, "correspondence_approver_user");

const config = {
  description:
    "Read one matter correspondence record with its filers and attachments.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "correspondence" },
  access: "read",
  params: workspaceParams({ correspondenceId: tSafeId("correspondence") }),
} satisfies WorkspaceHandlerConfig;

const getCorrespondence = createSafeHandler(
  config,
  async function* ({
    params: { correspondenceId },
    safeDb,
    session,
    workspaceId,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .select()
          .from(correspondence)
          .where(
            and(
              eq(correspondence.workspaceId, workspaceId),
              eq(correspondence.id, correspondenceId),
            ),
          )
          .limit(1);
        if (row === undefined) {
          return null;
        }
        const [filers, attachments] = await Promise.all([
          tx
            .select({
              userId: correspondenceFilers.filedByUserId,
              userName: filerUser.name,
              userDeletedAt: filerUser.deletedAt,
              approvedByName: approverUser.name,
              approvedByDeletedAt: approverUser.deletedAt,
              allowedSenderId: correspondenceFilers.filedByAllowedSenderId,
              address: correspondenceAllowedSenders.address,
              approvedBy: correspondenceAllowedSenders.approvedBy,
              filedAt: correspondenceFilers.filedAt,
            })
            .from(correspondenceFilers)
            .leftJoin(
              correspondenceAllowedSenders,
              eq(
                correspondenceFilers.filedByAllowedSenderId,
                correspondenceAllowedSenders.id,
              ),
            )
            // Historical actors are authorized by this matter-owned relationship,
            // even after their current organization membership is removed.
            .leftJoin(
              filerUser,
              eq(correspondenceFilers.filedByUserId, filerUser.id),
            )
            .leftJoin(
              approverUser,
              eq(correspondenceAllowedSenders.approvedBy, approverUser.id),
            )
            .where(
              and(
                eq(
                  correspondenceFilers.organizationId,
                  session.activeOrganizationId,
                ),
                eq(correspondenceFilers.workspaceId, workspaceId),
                eq(correspondenceFilers.correspondenceId, correspondenceId),
              ),
            )
            .orderBy(asc(correspondenceFilers.filedAt))
            .limit(MAX_FILERS_PER_RECORD + 1),
          tx
            .select({
              entityId: correspondenceAttachments.entityId,
              filename: correspondenceAttachments.filename,
              mediaType: correspondenceAttachments.mediaType,
              byteSize: correspondenceAttachments.byteSize,
              scanVerdict: correspondenceAttachments.scanVerdict,
            })
            .from(correspondenceAttachments)
            .where(
              and(
                eq(correspondenceAttachments.workspaceId, workspaceId),
                eq(
                  correspondenceAttachments.correspondenceId,
                  correspondenceId,
                ),
              ),
            )
            .orderBy(asc(correspondenceAttachments.ordinal))
            .limit(CORRESPONDENCE_MAX_ATTACHMENTS + 1),
        ]);
        if (filers.length > MAX_FILERS_PER_RECORD) {
          return panic("Correspondence filer count exceeds the bounded read");
        }
        if (attachments.length > CORRESPONDENCE_MAX_ATTACHMENTS) {
          return panic(
            "Correspondence attachment count exceeds the accepted limit",
          );
        }
        const {
          intake,
          originalSignature,
          authenticatedSenderAddress,
          spf,
          dkim,
          dmarc,
          alignedIdentifier,
          organizationId: _organizationId,
          workspaceId: _workspaceId,
          contentHash: _contentHash,
          dedupKey: _dedupKey,
          ...record
        } = row;
        return {
          record: {
            ...record,
            ...readCorrespondenceProvenance({
              intake,
              originalSignature,
              authenticatedSenderAddress,
              spf,
              dkim,
              dmarc,
              alignedIdentifier,
            }),
          },
          filers: filers.map((filer) => {
            if (filer.userId !== null) {
              return {
                type: "user" as const,
                userId: filer.userId,
                userName: filer.userDeletedAt === null ? filer.userName : null,
                userStatus:
                  filer.userDeletedAt === null
                    ? ("active" as const)
                    : ("deleted" as const),
                filedAt: filer.filedAt,
              };
            }
            if (
              filer.allowedSenderId === null ||
              filer.address === null ||
              filer.approvedBy === null
            ) {
              return panic("Incomplete mailbox filer provenance");
            }
            return {
              type: "shared_mailbox" as const,
              allowedSenderId: filer.allowedSenderId,
              address: filer.address,
              approvedBy: filer.approvedBy,
              approvedByName:
                filer.approvedByDeletedAt === null
                  ? filer.approvedByName
                  : null,
              approvedByStatus:
                filer.approvedByDeletedAt === null
                  ? ("active" as const)
                  : ("deleted" as const),
              filedAt: filer.filedAt,
            };
          }),
          attachments,
        };
      }),
    );
    if (result === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Correspondence not found" }),
      );
    }
    return Result.ok(result);
  },
);

export default getCorrespondence;

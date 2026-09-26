import { panic, Result } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import {
  correspondence,
  correspondenceAllowedSenders,
  correspondenceAttachments,
  correspondenceFilers,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
        if (row === undefined) return null;
        const [filers, attachments] = await Promise.all([
          tx
            .select({
              userId: correspondenceFilers.filedByUserId,
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
            .where(
              and(
                eq(correspondenceFilers.workspaceId, workspaceId),
                eq(correspondenceFilers.correspondenceId, correspondenceId),
              ),
            )
            .orderBy(asc(correspondenceFilers.filedAt)),
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
            .orderBy(asc(correspondenceAttachments.ordinal)),
        ]);
        const approverIds = [
          ...new Set(
            filers.flatMap((filer) =>
              filer.approvedBy === null ? [] : [filer.approvedBy],
            ),
          ),
        ];
        const approvers =
          approverIds.length === 0
            ? []
            : await tx
                .select({ id: user.id, name: user.name })
                .from(user)
                .innerJoin(
                  member,
                  and(
                    eq(member.userId, user.id),
                    eq(member.organizationId, session.activeOrganizationId),
                  ),
                )
                .where(inArray(user.id, approverIds));
        const approverNames = new Map(
          approvers.map((approver) => [approver.id, approver.name]),
        );
        const {
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
            authentication: { spf, dkim, dmarc, alignedIdentifier },
          },
          filers: filers.map((filer) => {
            if (filer.userId !== null)
              return {
                type: "user" as const,
                userId: filer.userId,
                filedAt: filer.filedAt,
              };
            if (
              filer.allowedSenderId === null ||
              filer.address === null ||
              filer.approvedBy === null
            )
              return panic("Incomplete mailbox filer provenance");
            return {
              type: "shared_mailbox" as const,
              allowedSenderId: filer.allowedSenderId,
              address: filer.address,
              approvedBy: filer.approvedBy,
              approvedByName: approverNames.get(filer.approvedBy) ?? null,
              filedAt: filer.filedAt,
            };
          }),
          attachments,
        };
      }),
    );
    if (result === null)
      return Result.err(
        new HandlerError({ status: 404, message: "Correspondence not found" }),
      );
    return Result.ok(result);
  },
);

export default getCorrespondence;

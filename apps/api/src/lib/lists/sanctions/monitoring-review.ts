import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SanctionsSource } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsScreeningEvents,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { monitoringFingerprint } from "@/api/lib/lists/sanctions/monitoring-input";
import { lockSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-lock";

export type ReviewSanctionsMatchOptions = {
  organizationId: SafeId<"organization">;
  contactId: SafeId<"contact">;
  reviewerId: SafeId<"user">;
  source: SanctionsSource;
  sourceEntryId: string;
  disposition: "dismissed" | "confirmed";
  expectedContactFingerprint: string;
  expectedEntryHash: string;
  reason: string;
  recordAuditEvent: AuditRecorder;
  now?: Date;
};

export const reviewSanctionsMatch = async (
  tx: Transaction,
  {
    organizationId,
    contactId,
    reviewerId,
    source,
    sourceEntryId,
    disposition,
    expectedContactFingerprint,
    expectedEntryHash,
    reason,
    recordAuditEvent,
    now = new Date(),
  }: ReviewSanctionsMatchOptions,
) => {
  const trimmedReason = reason.trim();
  if (trimmedReason.length === 0 || trimmedReason.length > 2000) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "validation_error",
        message: "A review reason of 1 to 2000 characters is required",
      }),
    );
  }
  await lockSanctionsMonitoring(tx, organizationId);
  const settings = (
    await tx
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
      .for("no key update")
  ).at(0);
  const contact = (
    await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          eq(contacts.id, contactId),
        ),
      )
      .limit(1)
      .for("no key update")
  ).at(0);
  if (contact === undefined) {
    return Result.err(
      new HandlerError({ status: 404, message: "Contact not found" }),
    );
  }
  const predicate = and(
    eq(sanctionsContactMatches.organizationId, organizationId),
    eq(sanctionsContactMatches.contactId, contactId),
    eq(sanctionsContactMatches.sourceId, source),
    eq(sanctionsContactMatches.sourceEntryId, sourceEntryId),
  );
  const match = (
    await tx
      .select()
      .from(sanctionsContactMatches)
      .where(predicate)
      .limit(1)
      .for("update")
  ).at(0);
  const freshness = (
    await readSanctionsFreshness({ db: async (read) => await read(tx), now })
  ).find((row) => row.source === source);
  if (
    freshness?.status !== "fresh" ||
    freshness.edition?.id !== match?.editionId ||
    settings?.sanctionsMonitoringMode === "disabled" ||
    contact.sanctionsMonitoringMode === "excluded" ||
    match?.state !== "active" ||
    match.contactFingerprint !== monitoringFingerprint(contact) ||
    match.contactFingerprint !== expectedContactFingerprint ||
    match.entryHash !== expectedEntryHash
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "conflict",
        message:
          "This match is no longer current; read contacts.sanctions.get before reviewing it",
      }),
    );
  }
  if (
    match.disposition === disposition &&
    match.reviewedBy === reviewerId &&
    match.reviewReason === trimmedReason &&
    match.reviewedContactFingerprint === match.contactFingerprint &&
    match.reviewedEntryHash === match.entryHash
  ) {
    return Result.ok(match);
  }
  const reviewed = (
    await tx
      .update(sanctionsContactMatches)
      .set({
        disposition,
        reviewedBy: reviewerId,
        reviewReason: trimmedReason,
        reviewedAt: now,
        reviewedContactFingerprint: match.contactFingerprint,
        reviewedEntryHash: match.entryHash,
        updatedAt: now,
      })
      .where(predicate)
      .returning()
  ).at(0);
  await tx.insert(sanctionsScreeningEvents).values({
    organizationId,
    contactId,
    sourceId: source,
    sourceEntryId,
    type: disposition,
    oldEditionId: match.editionId,
    newEditionId: match.editionId,
    reason: trimmedReason,
    reviewerId,
    contactFingerprint: match.contactFingerprint,
    entryHash: match.entryHash,
    oldMatch: match.match,
    newMatch: match.match,
    createdAt: now,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
    resourceId: contactId,
    workspaceId: null,
    changes: {
      sanctionsReview: { old: match.disposition, new: disposition },
      sanctionsReviewReason: { old: match.reviewReason, new: trimmedReason },
      sanctionsReviewEntry: { old: null, new: `${source}:${sourceEntryId}` },
    },
  });
  return Result.ok(reviewed);
};

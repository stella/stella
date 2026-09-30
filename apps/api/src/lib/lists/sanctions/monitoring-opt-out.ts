import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { isUuid } from "@stll/uuid-codec";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { monitoringFingerprint } from "@/api/lib/lists/sanctions/monitoring-input";
import { lockSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-lock";
import { requestSanctionsMonitoringRefresh } from "@/api/lib/lists/sanctions/monitoring-refresh";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";

type ContactMonitoringOptions = {
  organizationId: SafeId<"organization">;
  contactId: SafeId<"contact">;
  recordAuditEvent: AuditRecorder;
  now?: Date;
};

export const excludeSanctionsContact = async (
  tx: Transaction,
  {
    organizationId,
    contactId,
    recordAuditEvent,
    now = new Date(),
  }: ContactMonitoringOptions,
) => {
  await lockSanctionsMonitoring(tx, organizationId);
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
  const excluded = { ...contact, sanctionsMonitoringMode: "excluded" } as const;
  await tx
    .update(contacts)
    .set({ sanctionsMonitoringMode: "excluded" })
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        eq(contacts.id, contactId),
      ),
    );
  await tx
    .insert(sanctionsContactScreenings)
    .values(
      sanctionsSourceIds().map((sourceId) => ({
        organizationId,
        contactId,
        sourceId,
        editionId: null,
        status: "excluded" as const,
        reason: "contact-excluded",
        contactFingerprint: monitoringFingerprint(excluded),
        checkedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        sanctionsContactScreenings.organizationId,
        sanctionsContactScreenings.contactId,
        sanctionsContactScreenings.sourceId,
      ],
      set: {
        editionId: null,
        status: "excluded",
        reason: "contact-excluded",
        contactFingerprint: sql`excluded.contact_fingerprint`,
        checkedAt: now,
      },
    });
  await tx
    .update(sanctionsContactMatches)
    .set({ state: "lapsed", updatedAt: now })
    .where(
      and(
        eq(sanctionsContactMatches.organizationId, organizationId),
        eq(sanctionsContactMatches.contactId, contactId),
        eq(sanctionsContactMatches.state, "active"),
      ),
    );
  if (contact.sanctionsMonitoringMode !== "excluded") {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: contactId,
      workspaceId: null,
      changes: {
        sanctionsMonitoringMode: {
          old: contact.sanctionsMonitoringMode,
          new: "excluded",
        },
      },
    });
  }
  return Result.ok({ mode: "excluded" } as const);
};

type FirmMonitoringOptions = {
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  now?: Date;
};

export const disableSanctionsMonitoring = async (
  tx: Transaction,
  { organizationId, recordAuditEvent, now = new Date() }: FirmMonitoringOptions,
) => {
  await lockSanctionsMonitoring(tx, organizationId);
  const settings = (
    await tx
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
      .for("no key update")
  ).at(0);
  await tx
    .insert(organizationSettings)
    .values({
      id: createSafeId<"organizationSettings">(),
      organizationId,
      sanctionsMonitoringMode: "disabled",
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { sanctionsMonitoringMode: "disabled" },
    });
  await tx
    .update(sanctionsContactScreenings)
    .set({
      status: "excluded",
      reason: "monitoring-disabled",
      editionId: null,
      checkedAt: now,
    })
    .where(eq(sanctionsContactScreenings.organizationId, organizationId));
  await tx
    .update(sanctionsContactMatches)
    .set({ state: "lapsed", updatedAt: now })
    .where(
      and(
        eq(sanctionsContactMatches.organizationId, organizationId),
        eq(sanctionsContactMatches.state, "active"),
      ),
    );
  if (settings?.sanctionsMonitoringMode !== "disabled") {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      workspaceId: null,
      changes: {
        sanctionsMonitoringMode: {
          old: settings?.sanctionsMonitoringMode ?? "enabled",
          new: "disabled",
        },
      },
    });
  }
  return { mode: "disabled" } as const;
};

export const includeSanctionsContact = async (
  tx: Transaction,
  { organizationId, contactId, recordAuditEvent }: ContactMonitoringOptions,
) => {
  if (!isUuid(contactId)) {
    return Result.err(
      new HandlerError({ status: 400, message: "Contact ID must be a UUID" }),
    );
  }
  await lockSanctionsMonitoring(tx, organizationId);
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
  await tx
    .update(contacts)
    .set({ sanctionsMonitoringMode: "included" })
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        eq(contacts.id, contactId),
      ),
    );
  await requestSanctionsMonitoringRefresh(tx, {
    organizationId,
    contactIds: [contactId],
  });
  if (contact.sanctionsMonitoringMode !== "included") {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: contactId,
      workspaceId: null,
      changes: {
        sanctionsMonitoringMode: {
          old: contact.sanctionsMonitoringMode,
          new: "included",
        },
      },
    });
  }
  return Result.ok({ mode: "included" } as const);
};

export const enableSanctionsMonitoring = async (
  tx: Transaction,
  { organizationId, recordAuditEvent }: FirmMonitoringOptions,
) => {
  await lockSanctionsMonitoring(tx, organizationId);
  const settings = (
    await tx
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1)
      .for("no key update")
  ).at(0);
  await tx
    .insert(organizationSettings)
    .values({
      id: createSafeId<"organizationSettings">(),
      organizationId,
      sanctionsMonitoringMode: "enabled",
    })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { sanctionsMonitoringMode: "enabled" },
    });
  await requestSanctionsMonitoringRefresh(tx, { organizationId });
  if (settings?.sanctionsMonitoringMode === "disabled") {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      workspaceId: null,
      changes: { sanctionsMonitoringMode: { old: "disabled", new: "enabled" } },
    });
  }
  return { mode: "enabled" } as const;
};

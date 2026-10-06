import { panic, Result } from "better-result";
import { and, eq, isNull, isNotNull, ne, or } from "drizzle-orm";

import { isUuid } from "@stll/uuid-codec";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  organizationSettings,
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
  sanctionsContactScreenings,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  transitionScopedBatch,
  transitionScopedCount,
  transitionUpsertBatch,
} from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { monitoringFingerprint } from "@/api/lib/lists/sanctions/monitoring-input";
import { lapseSanctionsMatches } from "@/api/lib/lists/sanctions/monitoring-lapse";
import { lockSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-lock";
import { prepareSanctionsMonitoringRefresh } from "@/api/lib/lists/sanctions/monitoring-refresh";
import {
  CONTACT_MONITORING_TRANSITIONS,
  FIRM_MONITORING_TRANSITIONS,
  SCREENING_COVERAGE_TRANSITIONS,
} from "@/api/lib/lists/sanctions/monitoring-transition-specs";
import { SANCTIONS_SCREENING_STATUSES } from "@/api/lib/lists/sanctions/monitoring-vocabulary";
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
  const transitions = { count: 0 };
  if (contact.sanctionsMonitoringMode !== "excluded") {
    const changed = await transitionScopedBatch({
      tx,
      spec: CONTACT_MONITORING_TRANSITIONS,
      identities: [{ id: contactId }],
      options: { from: [contact.sanctionsMonitoringMode], to: "excluded" },
      recordTransitionAuditEvent: (_auditTx, rows) => {
        transitions.count += rows.length;
      },
    });
    if (changed.length !== 1) {
      panic("Locked contact mode changed during exclusion");
    }
  }
  await transitionUpsertBatch({
    tx,
    spec: SCREENING_COVERAGE_TRANSITIONS,
    values: sanctionsSourceIds().map((sourceId) => ({
      organizationId,
      contactId,
      sourceId,
      editionId: null,
      status: "excluded" as const,
      reason: "contact-excluded",
      contactFingerprint: monitoringFingerprint(excluded),
      checkedAt: now,
    })),
    recordTransitionAuditEvent: (_auditTx, rows) => {
      transitions.count += rows.length;
    },
  });
  await lapseSanctionsMatches(tx, {
    organizationId,
    contactIds: [contactId],
    now,
    recordTransitionAuditEvent: (_auditTx, count) => {
      transitions.count += count;
    },
  });
  if (contact.sanctionsMonitoringMode !== "excluded" || transitions.count > 0) {
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
  const transitions = { count: 0 };
  await transitionUpsertBatch({
    tx,
    spec: FIRM_MONITORING_TRANSITIONS,
    values: [
      {
        id: settings?.id ?? createSafeId<"organizationSettings">(),
        organizationId,
        sanctionsMonitoringMode: "disabled",
      },
    ],
    recordTransitionAuditEvent: (_auditTx, rows) => {
      transitions.count += rows.length;
    },
  });
  const fromStatuses = SANCTIONS_SCREENING_STATUSES.filter(
    (status) => status !== "excluded",
  );
  const firstStatus =
    fromStatuses.at(0) ?? panic("Screening coverage has no included state");
  await transitionScopedCount({
    tx,
    spec: SCREENING_COVERAGE_TRANSITIONS,
    where: eq(sanctionsContactScreenings.organizationId, organizationId),
    options: {
      from: [firstStatus, ...fromStatuses.slice(1)],
      to: "excluded",
      set: { reason: "monitoring-disabled", editionId: null, checkedAt: now },
    },
    recordTransitionAuditEvent: (_auditTx, count) => {
      transitions.count += count;
    },
  });
  // Coverage metadata can change without reopening the excluded lifecycle.
  await tx
    .update(sanctionsContactScreenings)
    .set({ reason: "monitoring-disabled", editionId: null, checkedAt: now })
    .where(
      and(
        eq(sanctionsContactScreenings.organizationId, organizationId),
        eq(sanctionsContactScreenings.status, "excluded"),
        or(
          ne(sanctionsContactScreenings.reason, "monitoring-disabled"),
          isNull(sanctionsContactScreenings.reason),
          isNotNull(sanctionsContactScreenings.editionId),
        ),
      ),
    );
  await lapseSanctionsMatches(tx, {
    organizationId,
    now,
    recordTransitionAuditEvent: (_auditTx, count) => {
      transitions.count += count;
    },
  });
  if (
    settings?.sanctionsMonitoringMode !== "disabled" ||
    transitions.count > 0
  ) {
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
  if (contact.sanctionsMonitoringMode !== "included") {
    const changed = await transitionScopedBatch({
      tx,
      spec: CONTACT_MONITORING_TRANSITIONS,
      identities: [{ id: contactId }],
      options: { from: [contact.sanctionsMonitoringMode], to: "included" },
      recordTransitionAuditEvent: (_auditTx, rows) => {
        if (rows.length !== 1) {
          panic("Contact inclusion transition missing");
        }
      },
    });
    if (changed.length !== 1) {
      panic("Locked contact mode changed during inclusion");
    }
  }
  const request = prepareSanctionsMonitoringRefresh({
    organizationId,
    contactIds: [contactId],
  });
  if (request.type !== "contacts") {
    panic("Contact inclusion requires contact refresh marks");
  }
  const marks = await tx
    .insert(sanctionsContactMarks)
    .values(request.rows)
    .onConflictDoNothing()
    .returning({ contactId: sanctionsContactMarks.contactId });
  if (contact.sanctionsMonitoringMode !== "included" || marks.length > 0) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
      resourceId: contactId,
      workspaceId: null,
      metadata: {
        monitoringMarkCount:
          contact.sanctionsMonitoringMode !== "included" ? 1 : marks.length,
      },
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
  const transitions = { count: 0 };
  await transitionUpsertBatch({
    tx,
    spec: FIRM_MONITORING_TRANSITIONS,
    values: [
      {
        id: settings?.id ?? createSafeId<"organizationSettings">(),
        organizationId,
        sanctionsMonitoringMode: "enabled",
      },
    ],
    recordTransitionAuditEvent: (_auditTx, rows) => {
      transitions.count += rows.length;
    },
  });
  const request = prepareSanctionsMonitoringRefresh({ organizationId });
  if (request.type !== "organization") {
    panic("Firm inclusion requires an organization refresh mark");
  }
  const marks = await tx
    .insert(sanctionsOrganizationMarks)
    .values(request.rows.at(0) ?? panic("Organization refresh mark missing"))
    .onConflictDoNothing()
    .returning({ organizationId: sanctionsOrganizationMarks.organizationId });
  if (transitions.count > 0 || marks.length > 0) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      workspaceId: null,
      metadata: {
        monitoringMarkCount:
          settings?.sanctionsMonitoringMode !== "enabled" ? 1 : marks.length,
      },
      changes: {
        sanctionsMonitoringMode: {
          old: settings?.sanctionsMonitoringMode ?? "enabled",
          new: "enabled",
        },
      },
    });
  }
  return { mode: "enabled" } as const;
};

import { and, eq, inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import {
  auditReadChangesSql,
  projectAuditReadChanges,
} from "@/api/lib/audit-log-details";
import type { AuditReadContext } from "@/api/lib/audit-log-details";
import type { SafeId } from "@/api/lib/branded-types";
import { escapeCSV } from "@/api/lib/csv";

/**
 * The one projection of audit rows into a downloadable table: the admin
 * audit-log export and the organization audit archive both write these
 * columns, with change details withheld exactly as the reader's feature access
 * withholds them on screen.
 */
export const AUDIT_LOG_EXPORT_CSV_HEADER = [
  "Time",
  "User Name",
  "User Email",
  "Action",
  "Resource Type",
  "Resource ID",
  "Changes",
  "Changes Status",
].join(",");

/** The audit columns an export reads, with change details already gated. */
export const auditLogExportColumns = (context: AuditReadContext) => ({
  createdAt: auditLogs.createdAt,
  userId: auditLogs.userId,
  action: auditLogs.action,
  resourceType: auditLogs.resourceType,
  resourceId: auditLogs.resourceId,
  changes: auditReadChangesSql(context),
  metadata: auditLogs.metadata,
});

export type AuditLogExportRow = {
  createdAt: Date;
  userId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  changes: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

export type AuditLogExportActor = { name: string; email: string };

/** Names and emails of the given actors who are members of the organization. */
export const readAuditLogExportActors = async (
  tx: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
  userIds: readonly string[],
): Promise<Map<string, AuditLogExportActor>> => {
  const unique = [...new Set(userIds)];
  const actors =
    unique.length > 0
      ? await tx
          .select({ id: user.id, name: user.name, email: user.email })
          .from(user)
          .innerJoin(member, eq(member.userId, user.id))
          .where(
            and(
              eq(member.organizationId, organizationId),
              inArray(user.id, unique),
            ),
          )
      : [];
  return new Map(
    actors.map((actor) => [actor.id, { name: actor.name, email: actor.email }]),
  );
};

type AuditLogExportCsvLineOptions = AuditReadContext & {
  row: AuditLogExportRow;
  actor: AuditLogExportActor | undefined;
};

export const auditLogExportCsvLine = ({
  row,
  actor,
  featureAccessSnapshot,
  principal,
}: AuditLogExportCsvLineOptions): string => {
  const details = projectAuditReadChanges({
    resourceType: row.resourceType,
    changes: row.changes,
    metadata: row.metadata,
    featureAccessSnapshot,
    principal,
  });
  return [
    escapeCSV(new Date(row.createdAt).toISOString()),
    escapeCSV(actor?.name ?? ""),
    escapeCSV(actor?.email ?? ""),
    escapeCSV(row.action),
    escapeCSV(row.resourceType),
    escapeCSV(row.resourceId),
    escapeCSV(details.changes ? JSON.stringify(details.changes) : ""),
    escapeCSV(details.changesStatus),
  ].join(",");
};

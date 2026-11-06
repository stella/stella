import { and, count, eq, inArray, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legislationDocuments,
  legislationMatterLinks,
  legislationSources,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import type { resolveMatterLinkProvisions } from "@/api/lib/legal-search/legislation-matter-link-provisions";
import { publishedLegislationDocumentFor } from "@/api/lib/legal-search/legislation-redistribution";
import {
  legislationVersionRef,
  opensOn,
} from "@/api/lib/legal-search/legislation-validity-window";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type MatterLinkRow = typeof legislationMatterLinks.$inferSelect;
const toMatterLinkResponse = (row: MatterLinkRow) => ({
  id: row.id,
  documentId: row.documentId,
  statuteId: row.statuteId,
  provisionId: row.provisionId,
  appliedVersion: row.appliedVersion,
  jurisdiction: row.jurisdiction,
  workspaceId: row.workspaceId,
  linkedBy: row.linkedBy,
  createdAt: row.createdAt,
});
type MatterLinkResponse = ReturnType<typeof toMatterLinkResponse>;
true satisfies UnprojectedColumns<
  MatterLinkRow,
  MatterLinkResponse
> extends never
  ? true
  : never;
true satisfies UnbackedProjectionKeys<
  MatterLinkRow,
  MatterLinkResponse
> extends never
  ? true
  : never;

type ResolvedProvisions = Awaited<
  ReturnType<typeof resolveMatterLinkProvisions>
>;
type ProvisionRequest = ResolvedProvisions[number]["item"];
type Rejection = ProvisionRequest & {
  reason:
    | Extract<ResolvedProvisions[number], { status: "rejected" }>["reason"]
    | "limit";
};
export type LegislationMatterLinkOutcome = {
  linked: MatterLinkResponse[];
  existing: MatterLinkResponse[];
  rejected: Rejection[];
};

export const linkProvisionsToMatter = async ({
  provisions,
  organizationId,
  recordAuditEvent,
  tx,
  userId,
  workspaceId,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  provisions: ResolvedProvisions;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
}): Promise<LegislationMatterLinkOutcome> => {
  if (provisions.length === 0) {
    return { linked: [], existing: [], rejected: [] };
  }
  await withAggregateLock({
    tx,
    aggregate: "workspace",
    id: { id: workspaceId, organizationId },
    mode: "update",
  });
  const documentIds = provisions.flatMap((provision) =>
    provision.status === "available" ? [provision.documentId] : [],
  );
  // Recheck publication after the outside-transaction payload read.
  const readable =
    documentIds.length === 0
      ? []
      : await tx
          .select({ id: legislationDocuments.id })
          .from(legislationDocuments)
          .innerJoin(
            legislationSources,
            eq(legislationSources.id, legislationDocuments.sourceId),
          )
          .where(
            and(
              or(
                ...provisions.flatMap((provision) =>
                  provision.status === "available"
                    ? [
                        and(
                          eq(legislationDocuments.id, provision.documentId),
                          eq(
                            legislationDocuments.eli,
                            provision.item.statuteId,
                          ),
                          eq(
                            legislationDocuments.country,
                            provision.item.jurisdiction,
                          ),
                          opensOn(
                            legislationVersionRef(legislationDocuments),
                            sql`${provision.item.version}::date`,
                          ),
                        ),
                      ]
                    : [],
                ),
              ),
              publishedLegislationDocumentFor("search"),
            ),
          )
          .limit(documentIds.length);
  const readableIds = new Set(readable.map((row) => row.id));
  const existingRows =
    documentIds.length === 0
      ? []
      : await tx
          .select()
          .from(legislationMatterLinks)
          .where(
            and(
              eq(legislationMatterLinks.workspaceId, workspaceId),
              inArray(legislationMatterLinks.documentId, documentIds),
            ),
          );
  const existingByKey = new Map(
    existingRows.map((row) => [`${row.documentId}\0${row.provisionId}`, row]),
  );
  const [countRow] = await tx
    .select({ value: count() })
    .from(legislationMatterLinks)
    .where(eq(legislationMatterLinks.workspaceId, workspaceId));
  let remaining =
    LIMITS.legislationMatterLinksPerWorkspace - (countRow?.value ?? 0);
  const existing: MatterLinkResponse[] = [];
  const rejected: Rejection[] = [];
  const inserts: (typeof legislationMatterLinks.$inferInsert)[] = [];
  for (const provision of provisions) {
    const { item } = provision;
    if (provision.status === "rejected") {
      rejected.push({ ...item, reason: provision.reason });
      continue;
    }
    if (!readableIds.has(provision.documentId)) {
      rejected.push({ ...item, reason: "not_found" });
      continue;
    }
    const prior = existingByKey.get(
      `${provision.documentId}\0${item.provisionId}`,
    );
    if (prior !== undefined) {
      existing.push(toMatterLinkResponse(prior));
      continue;
    }
    if (remaining-- <= 0) {
      rejected.push({ ...item, reason: "limit" });
      continue;
    }
    inserts.push({
      id: createSafeId<"legislationMatterLink">(),
      documentId: provision.documentId,
      statuteId: item.statuteId,
      provisionId: item.provisionId,
      appliedVersion: item.version,
      jurisdiction: item.jurisdiction,
      workspaceId,
      linkedBy: userId,
    });
  }
  if (inserts.length === 0) {
    return { linked: [], existing, rejected };
  }
  const linked = await tx
    .insert(legislationMatterLinks)
    .values(inserts)
    .returning();
  await recordAuditEvent(
    tx,
    linked.map((link) => ({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.LEGISLATION_MATTER_LINK,
      resourceId: link.id,
      workspaceId,
      metadata: {
        statuteId: link.statuteId,
        provisionId: link.provisionId,
        appliedVersion: link.appliedVersion,
        jurisdiction: link.jurisdiction,
      },
    })),
  );
  return { linked: linked.map(toMatterLinkResponse), existing, rejected };
};

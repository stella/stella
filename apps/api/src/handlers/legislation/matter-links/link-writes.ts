import { and, count, eq, inArray, or, sql } from "drizzle-orm";

import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

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
import { lockLegislationMatterLinks } from "@/api/lib/db/aggregate-lock";
import { parsePersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import {
  legislationVersionRef,
  opensOn,
} from "@/api/lib/legal-search/legislation-validity-window";
import { versionAstColumns } from "@/api/lib/legal-search/legislation-version-blocks";
import { LIMITS } from "@/api/lib/limits";

type Request = {
  statuteId: string;
  provisionId: string;
  version: string;
  jurisdiction: string;
};

type Rejection = Request & {
  reason: "not_found" | "out_of_jurisdiction" | "limit";
};
export type LegislationMatterLinkOutcome = {
  linked: (typeof legislationMatterLinks.$inferSelect)[];
  existing: (typeof legislationMatterLinks.$inferSelect)[];
  rejected: Rejection[];
};

export const linkProvisionsToMatter = async ({
  items,
  recordAuditEvent,
  tx,
  userId,
  workspaceId,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  items: readonly Request[];
  recordAuditEvent: AuditRecorder;
}): Promise<LegislationMatterLinkOutcome> => {
  const requests = [
    ...new Map(
      items.map((item) => [
        `${item.statuteId}\0${item.provisionId}\0${item.version}`,
        item,
      ]),
    ).values(),
  ];
  if (requests.length === 0) {
    return { linked: [], existing: [], rejected: [] };
  }
  await lockLegislationMatterLinks(tx, workspaceId);

  const admitted = new Set<string>(PUBLIC_LEGISLATION_COUNTRIES);
  const candidates = requests.filter((item) => admitted.has(item.jurisdiction));
  const documents =
    candidates.length === 0
      ? []
      : await tx
          .select({
            eli: legislationDocuments.eli,
            country: legislationDocuments.country,
            version: legislationDocuments.versionValidFrom,
            ...versionAstColumns,
          })
          .from(legislationDocuments)
          .innerJoin(
            legislationSources,
            eq(legislationSources.id, legislationDocuments.sourceId),
          )
          .where(
            or(
              ...candidates.map((item) =>
                and(
                  eq(legislationDocuments.eli, item.statuteId),
                  eq(legislationDocuments.country, item.jurisdiction),
                  opensOn(
                    legislationVersionRef(legislationDocuments),
                    sql`${item.version}::date`,
                  ),
                ),
              ),
            ),
          );
  const documentByKey = new Map(
    documents.map((row) => [
      `${row.eli}\0${row.country}\0${String(row.version)}`,
      row,
    ]),
  );
  const documentIds = documents.map((row) => row.id);
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
  const existing: typeof existingRows = [];
  const rejected: Rejection[] = [];
  const inserts: (typeof legislationMatterLinks.$inferInsert)[] = [];
  for (const item of requests) {
    if (!admitted.has(item.jurisdiction)) {
      rejected.push({ ...item, reason: "out_of_jurisdiction" });
      continue;
    }
    const document = documentByKey.get(
      `${item.statuteId}\0${item.jurisdiction}\0${item.version}`,
    );
    const ast = parsePersistedCorpusAst(document?.documentAst, document?.id);
    const blocks = ast !== null && "blocks" in ast ? ast.blocks : [];
    if (
      document === undefined ||
      !blocks.some((block) => block.anchorId === item.provisionId)
    ) {
      rejected.push({ ...item, reason: "not_found" });
      continue;
    }
    const prior = existingByKey.get(`${document.id}\0${item.provisionId}`);
    if (prior !== undefined) {
      existing.push(prior);
      continue;
    }
    if (remaining-- <= 0) {
      rejected.push({ ...item, reason: "limit" });
      continue;
    }
    inserts.push({
      id: createSafeId<"legislationMatterLink">(),
      documentId: document.id,
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
  return { linked, existing, rejected };
};

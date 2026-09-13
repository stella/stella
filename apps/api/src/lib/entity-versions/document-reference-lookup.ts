/**
 * Resolve a verification code to the entity version it was frozen onto. Both
 * the uploaded-DOCX check and the authenticated code resolution
 * answer from here, so the two cannot drift on what a match is or on how it
 * is scoped. The printed reference string (`2026/001/015.v3`) is never a
 * lookup key: a matter can be re-referenced and the freed reference reused,
 * so the same string can name two unrelated documents over time.
 *
 * Every lookup is organization-scoped in the query itself, on top of whatever
 * the caller's database handle already enforces: a verification code travels
 * outside the product (it is printed in the document), so a code belonging to
 * another organization must read as "not found", never as a cross-organization
 * disclosure.
 */

import { panic } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { DocumentReferenceMatch } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type LookupOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
};

/**
 * The version the document shows now, joined beside the matched one so the
 * reference it was refiled under costs no extra round trip.
 */
const currentVersions = alias(entityVersions, "current_version");

/** The columns the lookup projects, before the current-version read. */
const MATCH_COLUMNS = {
  entityId: entities.id,
  entityName: entities.name,
  workspaceId: workspaces.id,
  workspaceName: workspaces.name,
  stamp: entityVersions.stamp,
  versionNumber: entityVersions.versionNumber,
  currentStamp: currentVersions.stamp,
  currentVersionNumber: currentVersions.versionNumber,
};

/** What {@link completeMatch} reads off a matched row, structurally, so the
 *  projections above stay the single source of the row's shape. */
type MatchedVersion = {
  entityId: SafeId<"entity">;
  entityName: string;
  workspaceId: SafeId<"workspace">;
  workspaceName: string;
  stamp: string | null;
  versionNumber: number;
  currentStamp: string | null;
  currentVersionNumber: number | null;
};

const completeMatch = (row: MatchedVersion): DocumentReferenceMatch | null => {
  // A version carrying no reference cannot be what a reference resolved to.
  if (!row.stamp) {
    return null;
  }

  return {
    entityId: row.entityId,
    entityName: row.entityName,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    stamp: row.stamp,
    versionNumber: row.versionNumber,
    currentStamp: row.currentStamp,
    currentVersionNumber:
      row.currentVersionNumber ??
      panic("Document reference matched an entity whose current version is missing"),
  };
};

/**
 * Resolve a verification code. Codes are globally unique, so the code alone
 * identifies at most one version; the organization predicate decides whether
 * this caller may see it.
 */
export const lookupByVerificationCode = async ({
  tx,
  organizationId,
  verificationCode,
}: LookupOptions & {
  verificationCode: string;
}): Promise<DocumentReferenceMatch | null> => {
  const rows = await tx
    .select(MATCH_COLUMNS)
    .from(entityVersions)
    .innerJoin(entities, eq(entityVersions.entityId, entities.id))
    .innerJoin(
      workspaces,
      and(
        eq(entities.workspaceId, workspaces.id),
        eq(workspaces.organizationId, organizationId),
      ),
    )
    .leftJoin(
      currentVersions,
      eq(entities.currentVersionId, currentVersions.id),
    )
    .where(
      and(
        eq(entityVersions.verificationCode, verificationCode),
        isNull(entityVersions.deletedAt),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  return row ? completeMatch(row) : null;
};

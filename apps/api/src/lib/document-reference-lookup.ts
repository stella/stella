/**
 * One owner for resolving a document reference to the version it was frozen
 * onto: by verification code (globally unique) or by the reference string
 * (`2026/001/015.v3`, unique only within a matter). Both the uploaded-DOCX
 * check and the authenticated code resolution answer from here, so the two
 * cannot drift on what a match is or on how it is scoped.
 *
 * Every lookup is organization-scoped in the query itself, on top of whatever
 * the caller's database handle already enforces: a verification code travels
 * outside the product (it is printed in the document), so a code belonging to
 * another organization must read as "not found", never as a cross-organization
 * disclosure.
 */

import { panic } from "better-result";
import { and, desc, eq, isNull, max } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type DocumentReferenceMatch = {
  entityId: string;
  entityName: string | null;
  workspaceId: string;
  workspaceName: string;
  /** The reference frozen onto the matched version. */
  stamp: string;
  /** The version the reference points at: what the holder of the file has. */
  versionNumber: number;
  /**
   * Highest version number the document currently has, tombstoned versions
   * excluded. Equal to `versionNumber` when the reference points at the
   * latest version, higher when the file in hand has been superseded, which
   * is the one thing a reader of an old printout needs to be told.
   */
  currentVersionNumber: number;
};

type LookupOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
};

/** The columns both lookups project, before the current-version read. */
const MATCH_COLUMNS = {
  entityId: entities.id,
  entityName: entities.name,
  workspaceId: workspaces.id,
  workspaceName: workspaces.name,
  stamp: entityVersions.stamp,
  versionNumber: entityVersions.versionNumber,
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
};

/**
 * Second and last query of a lookup: the document's current version number.
 * One aggregate over the entity's versions, never a read per version.
 */
const completeMatch = async (
  tx: Transaction,
  row: MatchedVersion,
): Promise<DocumentReferenceMatch | null> => {
  // A version carrying no reference cannot be what a reference resolved to.
  if (!row.stamp) {
    return null;
  }

  const rows = await tx
    .select({ current: max(entityVersions.versionNumber) })
    .from(entityVersions)
    .where(
      and(
        eq(entityVersions.entityId, row.entityId),
        eq(entityVersions.workspaceId, row.workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    );

  return {
    entityId: row.entityId,
    entityName: row.entityName,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    stamp: row.stamp,
    versionNumber: row.versionNumber,
    // The matched row is itself non-deleted and belongs to this aggregate's
    // set, so a maximum exists.
    currentVersionNumber:
      rows.at(0)?.current ??
      panic("Document reference matched a version its entity has none of"),
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
    .where(
      and(
        eq(entityVersions.verificationCode, verificationCode),
        isNull(entityVersions.deletedAt),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  return row ? await completeMatch(tx, row) : null;
};

/**
 * Resolve a reference string. A reference is unique only within a matter and
 * the same string can be reprinted across matters, so the most recently
 * created version carrying it wins.
 */
export const lookupByStamp = async ({
  tx,
  organizationId,
  stamp,
}: LookupOptions & {
  stamp: string;
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
    .where(
      and(eq(entityVersions.stamp, stamp), isNull(entityVersions.deletedAt)),
    )
    .orderBy(desc(entityVersions.createdAt))
    .limit(1);

  const row = rows.at(0);
  return row ? await completeMatch(tx, row) : null;
};

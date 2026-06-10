/**
 * Shared source loader for clause-version diff endpoints. Resolves a
 * stored version and the clause's current version to plain text so
 * outdated template links can show what a sync would change. Mirrors
 * `templates/versions.ts#loadTemplateVersionDiffSources`, but clause
 * bodies live as JSONB in the database instead of DOCX files in S3.
 */

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

import { clauseBodyToPlainText } from "./clause-to-patch";

type ClauseVersionDiffSources =
  | { type: "not-found" }
  | { type: "ok"; prevText: string; currentText: string };

type DiffSourcesProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  clauseId: SafeId<"clause">;
  versionId: SafeId<"clauseVersion">;
};

/**
 * Resolve a clause version and the clause's current body to plain
 * text for diffing. Ownership is checked here so the diff/summarize
 * endpoints never expose content the caller's organization does not
 * own. `prevText` is the stored (older) version, `currentText` the
 * clause's current version.
 */
export const loadClauseVersionDiffSources = async ({
  scopedDb,
  organizationId,
  clauseId,
  versionId,
}: DiffSourcesProps): Promise<ClauseVersionDiffSources> => {
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: { id: { eq: clauseId }, organizationId: { eq: organizationId } },
      columns: { currentVersion: true, body: true },
    }),
  );
  if (!clause) {
    return { type: "not-found" };
  }

  const version = await scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: {
        id: { eq: versionId },
        clauseId: { eq: clauseId },
        organizationId: { eq: organizationId },
      },
      columns: { body: true },
    }),
  );
  if (!version) {
    return { type: "not-found" };
  }

  const currentSnapshot = await scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: {
        clauseId: { eq: clauseId },
        version: clause.currentVersion,
        organizationId: { eq: organizationId },
      },
      columns: { body: true },
    }),
  );

  // The current-version snapshot should always exist after creation;
  // fall back to the clause head only as a last resort so the diff
  // endpoint stays usable on legacy rows.
  const currentBody = currentSnapshot?.body ?? clause.body;

  return {
    type: "ok",
    prevText: clauseBodyToPlainText(version.body),
    currentText: clauseBodyToPlainText(currentBody),
  };
};

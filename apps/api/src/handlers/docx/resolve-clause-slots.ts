/**
 * Resolve clause slot markers to RichPatchValue content
 * by looking up linked clauses via the templateClauses
 * table and fetching their body from the appropriate
 * clauseVersion.
 */

import type { ScopedDb } from "@/api/db";
import { clauseBodyToRichPatch } from "@/api/handlers/clauses/clause-to-patch";
import type { SafeId } from "@/api/lib/branded-types";

import type { ClauseSlot } from "./discover-clause-slots";
import type { RichPatchValue } from "./types";

// ── Version parsing ──────────────────────────────────

const VERSION_NUM_RE = /^v(\d+)$/;

// ── Public API ───────────────────────────────────────

/**
 * For each clause slot, look up the linked clause and
 * resolve its body to a `RichPatchValue`. Returns a map
 * keyed by the full patch key (e.g., `@clause:NonCompete`)
 * that can be merged into `fillTemplate` values.
 *
 * Slots without a linked clause are silently skipped;
 * their marker will appear as an unmatched placeholder
 * in fill diagnostics.
 */
export const resolveClauseSlots = async (
  templateId: string,
  slots: ClauseSlot[],
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<Record<string, RichPatchValue>> => {
  if (slots.length === 0) {
    return {};
  }

  const patches: Record<string, RichPatchValue> = {};

  for (const slot of slots) {
    const link = await scopedDb((tx) =>
      tx.query.templateClauses.findFirst({
        where: {
          templateId,
          slotName: slot.name,
          organizationId: { eq: organizationId },
        },
        columns: {
          clauseId: true,
          clauseVersionId: true,
        },
      }),
    );

    if (!link || !link.clauseId) {
      continue;
    }

    const versionRow = await resolveVersion(
      link.clauseId,
      link.clauseVersionId,
      slot.versionModifier,
      scopedDb,
      organizationId,
    );

    if (!versionRow) {
      continue;
    }

    patches[slot.patchKey] = clauseBodyToRichPatch(versionRow.body);
  }

  return patches;
};

// ── Helpers ──────────────────────────────────────────

type VersionRow = {
  body: Parameters<typeof clauseBodyToRichPatch>[0];
};

const resolveVersion = async (
  clauseId: string,
  pinnedVersionId: string | null,
  modifier: string | undefined,
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<VersionRow | undefined> => {
  // :latest — always use the clause's current version
  if (modifier === "latest") {
    const clause = await scopedDb((tx) =>
      tx.query.clauses.findFirst({
        where: {
          id: clauseId,
          organizationId: { eq: organizationId },
        },
        columns: { currentVersion: true },
      }),
    );

    if (!clause) {
      return;
    }

    return scopedDb((tx) =>
      tx.query.clauseVersions.findFirst({
        where: {
          clauseId,
          version: clause.currentVersion,
          organizationId: { eq: organizationId },
        },
        columns: { body: true },
      }),
    );
  }

  // :vN — use a specific version number
  const vMatch = modifier?.match(VERSION_NUM_RE);
  if (vMatch) {
    const version = Number.parseInt(vMatch[1], 10);
    return scopedDb((tx) =>
      tx.query.clauseVersions.findFirst({
        where: {
          clauseId,
          version,
          organizationId: { eq: organizationId },
        },
        columns: { body: true },
      }),
    );
  }

  // No modifier — use the pinned version from the link
  if (pinnedVersionId) {
    return scopedDb((tx) =>
      tx.query.clauseVersions.findFirst({
        where: {
          id: pinnedVersionId,
          organizationId: { eq: organizationId },
        },
        columns: { body: true },
      }),
    );
  }

  // Fallback: use the clause's current version
  const clause = await scopedDb((tx) =>
    tx.query.clauses.findFirst({
      where: {
        id: clauseId,
        organizationId: { eq: organizationId },
      },
      columns: { currentVersion: true },
    }),
  );

  if (!clause) {
    return;
  }

  return scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: {
        clauseId,
        version: clause.currentVersion,
        organizationId: { eq: organizationId },
      },
      columns: { body: true },
    }),
  );
};

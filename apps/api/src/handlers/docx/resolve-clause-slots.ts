/**
 * Resolve clause slot markers to RichPatchValue content
 * by looking up linked clauses via the templateClauses
 * table and fetching their body from the appropriate
 * clauseVersion.
 */

import type { ScopedDb } from "@/api/db";
import {
  clauseBodyToPlainText,
  clauseBodyToRichPatch,
} from "@/api/handlers/clauses/clause-to-patch";
import { isVariantDeleted } from "@/api/handlers/clauses/template-links";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import type { SafeId } from "@/api/lib/branded-types";

import type { ClauseSlot } from "./discover-clause-slots";
import type { RichPatchValue } from "./types";

// ── Version parsing ──────────────────────────────────

const VERSION_NUM_RE = /^v(\d+)$/u;

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
  templateId: SafeId<"template">,
  slots: ClauseSlot[],
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<Record<string, RichPatchValue>> => {
  if (slots.length === 0) {
    return {};
  }

  const patches: Record<string, RichPatchValue> = {};

  for (const slot of slots) {
    const body = await resolveSlotBody(
      templateId,
      slot,
      scopedDb,
      organizationId,
    );
    if (body) {
      patches[slot.patchKey] = clauseBodyToRichPatch(body);
    }
  }

  return patches;
};

/**
 * Resolve each clause slot to its linked clause's PLAIN TEXT, keyed by
 * slot NAME (not the patch key) so the live fill preview can match the
 * folio clause-slot directive (`scanDirectives` exposes the slot name as
 * a clause range's `expr`). Uses the same version/variant resolution as
 * {@link resolveClauseSlots} so the preview matches what fill produces.
 *
 * The preview is a single inline indicator of what the slot fills with:
 * the clause text is flattened to one line and truncated. The actual fill
 * inserts the full rich clause via {@link resolveClauseSlots}; faithful
 * multi-paragraph layout in the live preview is a future item.
 */
const PREVIEW_MAX_CHARS = 180;
export const resolveClauseSlotTexts = async (
  templateId: SafeId<"template">,
  slots: ClauseSlot[],
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<Record<string, string>> => {
  if (slots.length === 0) {
    return {};
  }

  const texts: Record<string, string> = {};

  for (const slot of slots) {
    const body = await resolveSlotBody(
      templateId,
      slot,
      scopedDb,
      organizationId,
    );
    if (body) {
      const flat = clauseBodyToPlainText(body).replace(/\s+/gu, " ").trim();
      texts[slot.name] =
        flat.length > PREVIEW_MAX_CHARS
          ? `${flat.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
          : flat;
    }
  }

  return texts;
};

/**
 * Look up the clause linked to a slot and resolve its body via the
 * version/variant rules. Returns undefined when the slot is unlinked,
 * its variant is deleted (without an explicit modifier), or the target
 * version cannot be found.
 */
const resolveSlotBody = async (
  templateId: SafeId<"template">,
  slot: ClauseSlot,
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<ClauseBody | undefined> => {
  const link = await scopedDb((tx) =>
    tx.query.templateClauses.findFirst({
      where: {
        templateId: { eq: templateId },
        slotName: slot.name,
        organizationId: { eq: organizationId },
      },
      columns: {
        clauseId: true,
        clauseVariantId: true,
        clauseVariantLabel: true,
        clauseVersionId: true,
      },
    }),
  );

  if (!link || !link.clauseId) {
    return undefined;
  }

  // A deleted variant must not silently fall back to the clause
  // head. Leaving the marker unfilled reports it as an unmatched
  // placeholder (named after the slot) in fill diagnostics. An
  // explicit :latest / :vN modifier never used the variant, so it
  // still resolves.
  if (slot.versionModifier === undefined && isVariantDeleted(link)) {
    return undefined;
  }

  const versionRow = await resolveVersion({
    clauseId: link.clauseId,
    variantId: link.clauseVariantId,
    pinnedVersionId: link.clauseVersionId,
    modifier: slot.versionModifier,
    scopedDb,
    organizationId,
  });

  return versionRow?.body;
};

// ── Helpers ──────────────────────────────────────────

type VersionRow = {
  body: Parameters<typeof clauseBodyToRichPatch>[0];
};

type ResolveVersionOptions = {
  clauseId: SafeId<"clause">;
  variantId: SafeId<"clauseVariant"> | null;
  pinnedVersionId: SafeId<"clauseVersion"> | null;
  modifier: string | undefined;
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
};

const resolveVersion = async ({
  clauseId,
  variantId,
  pinnedVersionId,
  modifier,
  scopedDb,
  organizationId,
}: ResolveVersionOptions): Promise<VersionRow | undefined> => {
  // :latest — always use the clause's current version
  if (modifier === "latest") {
    const clause = await scopedDb((tx) =>
      tx.query.clauses.findFirst({
        where: {
          id: { eq: clauseId },
          organizationId: { eq: organizationId },
        },
        columns: { currentVersion: true },
      }),
    );

    if (!clause) {
      return undefined;
    }

    return scopedDb((tx) =>
      tx.query.clauseVersions.findFirst({
        where: {
          clauseId: { eq: clauseId },
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
    const version = Number.parseInt(vMatch[1] ?? "0", 10);
    return scopedDb((tx) =>
      tx.query.clauseVersions.findFirst({
        where: {
          clauseId: { eq: clauseId },
          version,
          organizationId: { eq: organizationId },
        },
        columns: { body: true },
      }),
    );
  }

  // A linked variant is an author-chosen alternative body (not a
  // version). It wins over the pinned/current version, but an explicit
  // slot modifier (:latest / :vN, handled above) still takes precedence
  // — that marker targets the clause's main versions, not the variant.
  if (variantId) {
    return scopedDb((tx) =>
      tx.query.clauseVariants.findFirst({
        where: {
          id: { eq: variantId },
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
          id: { eq: pinnedVersionId },
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
        id: { eq: clauseId },
        organizationId: { eq: organizationId },
      },
      columns: { currentVersion: true },
    }),
  );

  if (!clause) {
    return undefined;
  }

  return scopedDb((tx) =>
    tx.query.clauseVersions.findFirst({
      where: {
        clauseId: { eq: clauseId },
        version: clause.currentVersion,
        organizationId: { eq: organizationId },
      },
      columns: { body: true },
    }),
  );
};

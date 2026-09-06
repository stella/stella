/**
 * Resolve clause slot markers to RichPatchValue content
 * by looking up linked clauses via the templateClauses
 * table and fetching their body from the appropriate
 * clauseVersion.
 */

import { panic } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { clauseVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  clauseBodyToPlainText,
  clauseBodyToRichPatch,
} from "@/api/lib/clauses/clause-to-patch";
import type { ClauseBody } from "@/api/lib/clauses/types";
import { LIMITS } from "@/api/lib/limits";
import { isVariantDeleted } from "@/api/lib/template-clause-links";

import type { ClauseSlot } from "./discover-clause-slots";
import type { RichPatchValue } from "./types";

// ── Version parsing ──────────────────────────────────

const VERSION_NUM_RE = /^v(?<num>\d+)$/u;

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
  const bodies = await resolveSlotBodies(
    templateId,
    slots,
    scopedDb,
    organizationId,
  );

  const patches: Record<string, RichPatchValue> = {};

  for (const slot of slots) {
    const body = bodies.get(slot.patchKey);
    if (body) {
      patches[slot.patchKey] = clauseBodyToRichPatch(body);
    }
  }

  return patches;
};

/**
 * Like {@link resolveClauseSlots}, but returns each slot's raw `ClauseBody`
 * (keyed by patch key) instead of the converted rich patch. Lets the fill UI
 * show the clause and offer a per-fill AI adjustment before it is inserted.
 */
export const resolveClauseSlotBodies = async (
  templateId: SafeId<"template">,
  slots: ClauseSlot[],
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<Record<string, ClauseBody>> => {
  const resolved = await resolveSlotBodies(
    templateId,
    slots,
    scopedDb,
    organizationId,
  );

  const bodies: Record<string, ClauseBody> = {};

  for (const slot of slots) {
    const body = resolved.get(slot.patchKey);
    if (body) {
      bodies[slot.patchKey] = body;
    }
  }

  return bodies;
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
export const resolveClauseSlotTexts = async (
  templateId: SafeId<"template">,
  slots: ClauseSlot[],
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<Record<string, string>> => {
  const bodies = await resolveSlotBodies(
    templateId,
    slots,
    scopedDb,
    organizationId,
  );

  const texts: Record<string, string> = {};

  for (const slot of slots) {
    const body = bodies.get(slot.patchKey);
    if (body) {
      // Flatten paragraph breaks so the clause flows as one inline run in the
      // preview (wraps within the column); the actual fill inserts the full
      // multi-paragraph rich clause. Not truncated — the author sees it all.
      texts[slot.name] = clauseBodyToPlainText(body)
        .replace(/\s+/gu, " ")
        .trim();
    }
  }

  return texts;
};

// ── Batched resolution ───────────────────────────────

/** The body a slot's link points at, before any row is read. */
type SlotTarget =
  | { type: "variant"; variantId: SafeId<"clauseVariant"> }
  | { type: "pinnedVersion"; versionId: SafeId<"clauseVersion"> }
  | { type: "clauseVersion"; clauseId: SafeId<"clause">; version: number }
  | { type: "currentVersion"; clauseId: SafeId<"clause"> };

type SlotLink = {
  clauseId: SafeId<"clause"> | null;
  clauseVariantId: SafeId<"clauseVariant"> | null;
  clauseVariantLabel: string | null;
  clauseVersionId: SafeId<"clauseVersion"> | null;
};

/**
 * Which body a slot resolves to, from the link row alone. Returns undefined
 * when the slot is unlinked or its variant is deleted (without an explicit
 * modifier).
 */
const planSlotTarget = (
  slot: ClauseSlot,
  link: SlotLink,
): SlotTarget | undefined => {
  const clauseId = link.clauseId;
  if (!clauseId) {
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

  // :latest — always use the clause's current version
  if (slot.versionModifier === "latest") {
    return { type: "currentVersion", clauseId };
  }

  // :vN — use a specific version number
  const vMatch = slot.versionModifier?.match(VERSION_NUM_RE);
  if (vMatch) {
    return {
      type: "clauseVersion",
      clauseId,
      version: Number.parseInt(vMatch.groups?.["num"] ?? "0", 10),
    };
  }

  // A linked variant is an author-chosen alternative body (not a
  // version). It wins over the pinned/current version, but an explicit
  // slot modifier (:latest / :vN, handled above) still takes precedence
  // — that marker targets the clause's main versions, not the variant.
  if (link.clauseVariantId) {
    return { type: "variant", variantId: link.clauseVariantId };
  }

  // No modifier — use the pinned version from the link
  if (link.clauseVersionId) {
    return { type: "pinnedVersion", versionId: link.clauseVersionId };
  }

  return { type: "currentVersion", clauseId };
};

/** `clause_versions` is unique on (clauseId, version); key its bodies the same. */
const clauseVersionKey = (
  clauseId: SafeId<"clause">,
  version: number,
): string => `${clauseId}:${version}`;

type TargetBodies = {
  currentVersionByClauseId: ReadonlyMap<SafeId<"clause">, number>;
  bodyByClauseVersion: ReadonlyMap<string, ClauseBody>;
  bodyByVersionId: ReadonlyMap<SafeId<"clauseVersion">, ClauseBody>;
  bodyByVariantId: ReadonlyMap<SafeId<"clauseVariant">, ClauseBody>;
};

const targetBody = (
  target: SlotTarget,
  bodies: TargetBodies,
): ClauseBody | undefined => {
  switch (target.type) {
    case "variant":
      return bodies.bodyByVariantId.get(target.variantId);
    case "pinnedVersion":
      return bodies.bodyByVersionId.get(target.versionId);
    case "clauseVersion":
      return bodies.bodyByClauseVersion.get(
        clauseVersionKey(target.clauseId, target.version),
      );
    case "currentVersion": {
      const version = bodies.currentVersionByClauseId.get(target.clauseId);
      return version === undefined
        ? undefined
        : bodies.bodyByClauseVersion.get(
            clauseVersionKey(target.clauseId, version),
          );
    }
    default:
      target satisfies never;
      return panic(`Unhandled clause slot target: ${String(target)}`);
  }
};

/**
 * Resolve every slot's clause body in a fixed number of reads, whatever the
 * slot count: one `templateClauses` read for the whole slot set, one `clauses`
 * read for the clause ids whose current version is needed, one `clauseVersions`
 * read over the (clauseId, version) and pinned-id targets, and one
 * `clauseVariants` read over the linked variants. Reads past the first are
 * skipped when nothing targets them.
 *
 * Keyed by patch key, not slot name: two markers can name the same slot with
 * different version modifiers (`{{@clause:X}}` and `{{@clause:X:v2}}`) and
 * resolve to different bodies.
 */
const resolveSlotBodies = async (
  templateId: SafeId<"template">,
  slots: ClauseSlot[],
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<Map<string, ClauseBody>> => {
  if (slots.length === 0) {
    return new Map();
  }

  const slotNames = [...new Set(slots.map((slot) => slot.name))];

  return scopedDb(async (tx) => {
    const links = await tx.query.templateClauses.findMany({
      where: {
        templateId: { eq: templateId },
        organizationId: { eq: organizationId },
        slotName: { in: slotNames },
      },
      columns: {
        slotName: true,
        clauseId: true,
        clauseVariantId: true,
        clauseVariantLabel: true,
        clauseVersionId: true,
      },
      // A template holds at most this many links, so the bound never truncates
      // a slot set the markers could legitimately match.
      limit: LIMITS.templateClausesPerTemplate,
    });

    const linkBySlotName = new Map(links.map((link) => [link.slotName, link]));

    const targets = new Map<string, SlotTarget>();
    for (const slot of slots) {
      const link = linkBySlotName.get(slot.name);
      if (!link) {
        continue;
      }
      const target = planSlotTarget(slot, link);
      if (target) {
        targets.set(slot.patchKey, target);
      }
    }

    const currentVersionClauseIds = new Set<SafeId<"clause">>();
    const pinnedVersionIds = new Set<SafeId<"clauseVersion">>();
    const variantIds = new Set<SafeId<"clauseVariant">>();
    const versionPairs = new Map<
      string,
      { clauseId: SafeId<"clause">; version: number }
    >();

    for (const target of targets.values()) {
      switch (target.type) {
        case "variant":
          variantIds.add(target.variantId);
          break;
        case "pinnedVersion":
          pinnedVersionIds.add(target.versionId);
          break;
        case "clauseVersion":
          versionPairs.set(
            clauseVersionKey(target.clauseId, target.version),
            target,
          );
          break;
        case "currentVersion":
          currentVersionClauseIds.add(target.clauseId);
          break;
        default:
          target satisfies never;
          return panic(`Unhandled clause slot target: ${String(target)}`);
      }
    }

    const currentVersionByClauseId = new Map<SafeId<"clause">, number>();
    if (currentVersionClauseIds.size > 0) {
      const clauseRows = await tx.query.clauses.findMany({
        where: {
          id: { in: [...currentVersionClauseIds] },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, currentVersion: true },
        limit: currentVersionClauseIds.size,
      });

      for (const clause of clauseRows) {
        currentVersionByClauseId.set(clause.id, clause.currentVersion);
        versionPairs.set(clauseVersionKey(clause.id, clause.currentVersion), {
          clauseId: clause.id,
          version: clause.currentVersion,
        });
      }
    }

    const versionPredicates = [...versionPairs.values()].map(
      ({ clauseId, version }) =>
        and(
          eq(clauseVersions.clauseId, clauseId),
          eq(clauseVersions.version, version),
        ),
    );
    if (pinnedVersionIds.size > 0) {
      versionPredicates.push(inArray(clauseVersions.id, [...pinnedVersionIds]));
    }

    const bodyByVersionId = new Map<SafeId<"clauseVersion">, ClauseBody>();
    const bodyByClauseVersion = new Map<string, ClauseBody>();
    if (versionPredicates.length > 0) {
      const versionRows = await tx
        .select({
          id: clauseVersions.id,
          clauseId: clauseVersions.clauseId,
          version: clauseVersions.version,
          body: clauseVersions.body,
        })
        .from(clauseVersions)
        .where(
          and(
            eq(clauseVersions.organizationId, organizationId),
            or(...versionPredicates),
          ),
        )
        .limit(versionPairs.size + pinnedVersionIds.size);

      for (const row of versionRows) {
        bodyByVersionId.set(row.id, row.body);
        bodyByClauseVersion.set(
          clauseVersionKey(row.clauseId, row.version),
          row.body,
        );
      }
    }

    const bodyByVariantId = new Map<SafeId<"clauseVariant">, ClauseBody>();
    if (variantIds.size > 0) {
      const variantRows = await tx.query.clauseVariants.findMany({
        where: {
          id: { in: [...variantIds] },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, body: true },
        limit: variantIds.size,
      });

      for (const variant of variantRows) {
        bodyByVariantId.set(variant.id, variant.body);
      }
    }

    const bodies = new Map<string, ClauseBody>();
    for (const slot of slots) {
      const target = targets.get(slot.patchKey);
      if (!target) {
        continue;
      }
      const body = targetBody(target, {
        currentVersionByClauseId,
        bodyByClauseVersion,
        bodyByVersionId,
        bodyByVariantId,
      });
      if (body) {
        bodies.set(slot.patchKey, body);
      }
    }

    return bodies;
  });
};

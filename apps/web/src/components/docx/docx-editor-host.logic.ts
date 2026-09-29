/**
 * The hosted DOCX editor's slot registry — decision logic only.
 *
 * One Folio instance per document, two places it can be read in: the
 * document route's main pane and the inspector's file preview. Swapping the
 * panes used to tear the instance down and build another one (refetch,
 * reparse, relayout, lost scroll, a live edit session at risk). The host
 * keeps the instance and moves its DOM node between the two slots instead.
 *
 * Each place that can show the document registers a *claim*. The claim
 * carries everything about the document that differs between the two slots,
 * so the slot drives props rather than identity. The newest claim wins, which
 * is what a swap means: the arriving slot takes the editor from the leaving
 * one, in whichever order the two commit.
 *
 * Releasing the last claim does not drop the instance immediately: a swap
 * unmounts one slot and mounts the other across two commits, and an
 * in-between teardown would be exactly the rebuild this exists to avoid. The
 * entry waits out a grace window and is swept only if nothing claimed it.
 */

import type { RefObject } from "react";

import type { DocxCompatibility } from "@stll/folio-react";

import type { DocxBrowserEditorActions } from "@/components/docx/use-docx-browser-editor-actions";
import { DOCUMENT_PANE } from "@/components/inspector/document-pane";
import type { DocumentPane } from "@/components/inspector/document-pane";

export const DOCX_EDITOR_SLOT = {
  main: "main",
  inspector: "inspector",
} as const;

export type DocxEditorSlotName =
  (typeof DOCX_EDITOR_SLOT)[keyof typeof DOCX_EDITOR_SLOT];

/**
 * Which slot the document is read in, per arrangement. Total over the pane
 * vocabulary so a new arrangement cannot land without deciding where its
 * document lives.
 */
export const DOCX_EDITOR_SLOT_BY_PANE = {
  [DOCUMENT_PANE.document]: DOCX_EDITOR_SLOT.main,
  [DOCUMENT_PANE.review]: DOCX_EDITOR_SLOT.inspector,
  [DOCUMENT_PANE.margin]: DOCX_EDITOR_SLOT.main,
} as const satisfies Record<DocumentPane, DocxEditorSlotName>;

/** How long an unclaimed instance survives, so a pane swap never sees it gone. */
export const DOCX_EDITOR_RELEASE_GRACE_MS = 2000;

export type DocxEditorDocument = {
  workspaceId: string;
  entityId: string;
  fileFieldId: string;
  propertyId: string;
};

/** One hosted instance per document field, not per place it is shown. */
export const docxEditorHostKey = ({
  workspaceId,
  entityId,
  fileFieldId,
}: Omit<DocxEditorDocument, "propertyId">): string =>
  `${workspaceId}:${entityId}:${fileFieldId}`;

/**
 * What the slot wants told back. Every entry is referentially stable for the
 * slot's lifetime (`useLatestCallback` at the slot, refs owned by the site),
 * so a claim is rewritten only when a value in it actually changed. They ride
 * on the claim rather than in a parallel map: one write registers both, one
 * release drops both, and there is no second structure to keep in step.
 */
export type DocxEditorSlotBindings = {
  onBlockedUnlock?: (() => void) | undefined;
  onClose: () => void;
  onCollaborationPublishableChange?:
    | ((publishable: boolean) => void)
    | undefined;
  onCompatibilityChange?:
    | ((compatibility: DocxCompatibility) => void)
    | undefined;
  onError?: ((error: Error) => void) | undefined;
  onSaved?: ((fieldId: string) => void) | undefined;
  onScrollTopChange?: ((scrollTop: number) => void) | undefined;
  onUnlockedChange?: ((unlocked: boolean) => void) | undefined;
  /** The editor-command handles the slot's own chrome reads. */
  actionsKey?: string | undefined;
  actionsMapRef?: RefObject<Map<string, DocxBrowserEditorActions>> | undefined;
  actionsRef?: RefObject<DocxBrowserEditorActions | null> | undefined;
};

type DocxEditorClaimBase = {
  /** Assigned once per slot mount, monotonic. The newest claim drives the
   *  instance, and a release must name the sequence it registered with. */
  sequence: number;
  document: DocxEditorDocument;
  canUnlock: boolean;
  isEditing: boolean;
  scaleOffset: number | undefined;
  bindings: DocxEditorSlotBindings;
};

/**
 * What each slot asks the hosted editor to be. The two branches are not the
 * same payload with a label: the full view owns the page (Folio keeps its own
 * find dialog and the route publishes the action bar), while the docked
 * inspector owns a scroll position and draws no action bar of its own.
 */
export type DocxEditorClaim =
  | (DocxEditorClaimBase & {
      slot: typeof DOCX_EDITOR_SLOT.main;
      surface: "fullView";
    })
  | (DocxEditorClaimBase & {
      slot: typeof DOCX_EDITOR_SLOT.inspector;
      surface: "inspector";
      initialScrollTop: number | undefined;
    });

export type DocxEditorHostEntry = {
  /** At most one claim per slot. */
  claims: readonly DocxEditorClaim[];
  /** The claim that last drove the instance. Kept after the final release so
   *  the editor keeps rendering through the grace window: a swap unmounts one
   *  slot before the other mounts, and a teardown in between is the rebuild
   *  this exists to avoid. */
  lastClaim: DocxEditorClaim;
  /** When the last claim went away; `null` while any slot still holds it. */
  releasedAt: number | null;
};

export type DocxEditorHostRegistry = Readonly<
  Record<string, DocxEditorHostEntry>
>;

export const EMPTY_DOCX_EDITOR_REGISTRY: DocxEditorHostRegistry = {};

const newestClaim = (
  claims: readonly DocxEditorClaim[],
): DocxEditorClaim | null => {
  let newest: DocxEditorClaim | null = null;
  for (const claim of claims) {
    if (newest === null || claim.sequence > newest.sequence) {
      newest = claim;
    }
  }
  return newest;
};

/**
 * The claim the hosted instance renders: the most recently registered live
 * one, or — while nothing claims it — the one it was last shown under, so the
 * instance survives the window between the two halves of a swap.
 *
 * A slot that has gone away never drives the instance while a mounted one
 * holds a claim: `lastClaim` is the grace-window fallback, not a candidate
 * beside the live claims. Releasing the newest slot therefore hands the
 * instance back to the older live slot instead of leaving the departed one
 * pointing at a target that no longer exists.
 */
export const selectActiveDocxEditorClaim = (
  entry: DocxEditorHostEntry | undefined,
): DocxEditorClaim | null =>
  entry === undefined ? null : (newestClaim(entry.claims) ?? entry.lastClaim);

/**
 * The claim the instance is shown under, chosen from the slots that have
 * registered a target element rather than from the registry alone: the newest
 * live claim whose slot is mounted. A slot that has claimed but not yet
 * mounted its element, and the grace window where nothing claims the instance
 * at all, fall back to the active claim and leave the editor where it is.
 */
export const selectMountedDocxEditorClaim = (
  entry: DocxEditorHostEntry | undefined,
  isSlotMounted: (slot: DocxEditorSlotName) => boolean,
): DocxEditorClaim | null =>
  entry === undefined
    ? null
    : (newestClaim(entry.claims.filter((claim) => isSlotMounted(claim.slot))) ??
      selectActiveDocxEditorClaim(entry));

/** Whether a slot is currently showing the instance, or it is only waiting out
 *  its grace window. */
export const isDocxEditorHostClaimed = (
  entry: DocxEditorHostEntry | undefined,
): boolean => entry !== undefined && entry.claims.length > 0;

type ClaimOptions = {
  hostKey: string;
  claim: DocxEditorClaim;
};

/**
 * Register or refresh a slot's claim. A claim inside the grace window revives
 * the entry rather than starting a new one — that is the swap, and the whole
 * point of the window.
 */
export const claimDocxEditorSlot = (
  registry: DocxEditorHostRegistry,
  { hostKey, claim }: ClaimOptions,
): DocxEditorHostRegistry => {
  const entry = registry[hostKey];
  const claims =
    entry === undefined
      ? [claim]
      : [...entry.claims.filter((held) => held.slot !== claim.slot), claim];

  return {
    ...registry,
    [hostKey]: { claims, lastClaim: claim, releasedAt: null },
  };
};

type ReleaseOptions = {
  hostKey: string;
  slot: DocxEditorSlotName;
  /** The sequence the releasing slot registered with. A stale teardown that
   *  arrives after the same slot re-claimed must not take the new claim with
   *  it, which is what a fast remount inside one slot does. */
  sequence: number;
  now: number;
};

export const releaseDocxEditorSlot = (
  registry: DocxEditorHostRegistry,
  { hostKey, slot, sequence, now }: ReleaseOptions,
): DocxEditorHostRegistry => {
  const entry = registry[hostKey];
  if (entry === undefined) {
    return registry;
  }

  const claims = entry.claims.filter(
    (held) => !(held.slot === slot && held.sequence === sequence),
  );
  if (claims.length === entry.claims.length) {
    return registry;
  }

  return {
    ...registry,
    [hostKey]: {
      claims,
      // The instance keeps the claim it was last shown under until something
      // claims it again, so releasing never blanks the editor.
      lastClaim: newestClaim(claims) ?? entry.lastClaim,
      releasedAt: claims.length === 0 ? now : null,
    },
  };
};

type SweepOptions = {
  now: number;
  graceMs: number;
};

/** Drop the instances whose grace window has run out. */
export const sweepDocxEditorRegistry = (
  registry: DocxEditorHostRegistry,
  { now, graceMs }: SweepOptions,
): DocxEditorHostRegistry => {
  const survivors = Object.entries(registry).filter(
    ([, entry]) =>
      entry.releasedAt === null || entry.releasedAt + graceMs > now,
  );
  if (survivors.length === Object.keys(registry).length) {
    return registry;
  }
  return Object.fromEntries(survivors);
};

/** When the next sweep is due, so the host arms one timer instead of polling. */
export const nextDocxEditorSweepAt = (
  registry: DocxEditorHostRegistry,
  graceMs: number,
): number | null => {
  let earliest: number | null = null;
  for (const entry of Object.values(registry)) {
    if (entry.releasedAt === null) {
      continue;
    }
    const due = entry.releasedAt + graceMs;
    if (earliest === null || due < earliest) {
      earliest = due;
    }
  }
  return earliest;
};

/**
 * The error surface each slot gets. Total over the slot vocabulary: one
 * instance serves both places, so the fallback follows the slot it is shown
 * in rather than the site that happened to mount it.
 */
export const DOCX_EDITOR_ERROR_SURFACE_BY_SLOT = {
  [DOCX_EDITOR_SLOT.main]: "route",
  [DOCX_EDITOR_SLOT.inspector]: "inspector",
} as const satisfies Record<DocxEditorSlotName, "route" | "inspector">;

export const docxEditorSlotForPane = (pane: DocumentPane): DocxEditorSlotName =>
  DOCX_EDITOR_SLOT_BY_PANE[pane];

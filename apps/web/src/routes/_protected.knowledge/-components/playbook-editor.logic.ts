import {
  normalizePosition,
  type PlaybookPerspective,
  type PlaybookPositionsValue,
  type PlaybookTrigger,
  type Position,
} from "@/lib/knowledge/playbook-types";
import { stableStringify } from "@/lib/stable-stringify";

type ResolvePlaybookScrollTopArgs = {
  containerScrollTop: number;
  containerTop: number;
  targetTop: number;
  topOffset: number;
};

export const resolvePlaybookScrollTop = ({
  containerScrollTop,
  containerTop,
  targetTop,
  topOffset,
}: ResolvePlaybookScrollTopArgs) =>
  Math.max(0, containerScrollTop + targetTop - containerTop - topOffset);

/** Everything the editor can put into a save. */
export type PlaybookDraft = {
  name: string;
  description: string;
  documentTypeKey: string | null;
  // Not editable in the form today, but part of the saved scope, so they
  // belong to the draft: a fingerprint that ignored them would miss a change
  // the save would still persist.
  perspective: PlaybookPerspective | null;
  trigger: PlaybookTrigger | null;
  positions: readonly Position[];
};

/**
 * The exact body the editor sends to `POST /playbooks` and
 * `PUT /playbooks/:playbookId`. Building it here rather than inline in the
 * component is what lets the dirty check fingerprint the real payload: a new
 * saveable field cannot be added without also entering dirty tracking.
 *
 * "When to run" is no longer a playbook setting (it belongs to a future
 * Workflows layer), so the editor never mutates the trigger; it carries the
 * stored value through the routing seam. The scope is omitted entirely in the
 * all-defaults case so the handler clears it, and whenever a scope is sent
 * `trigger` rides along explicitly (absent optional fields must not be left
 * to server defaults).
 */
export const buildPlaybookSavePayload = ({
  name,
  description,
  documentTypeKey,
  perspective,
  trigger,
  positions,
}: PlaybookDraft) => {
  const trimmedDescription = description.trim();
  const resolvedTrigger = trigger ?? "manual";
  const scope =
    documentTypeKey === null &&
    perspective === null &&
    resolvedTrigger === "manual"
      ? undefined
      : {
          ...(documentTypeKey !== null ? { documentTypeKey } : {}),
          ...(perspective !== null ? { perspective } : {}),
          trigger: resolvedTrigger,
        };
  const positionsPayload: PlaybookPositionsValue = {
    version: 3,
    items: positions.map(normalizePosition),
  };

  return {
    name: name.trim(),
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
    ...(scope ? { scope } : {}),
    positions: positionsPayload,
  };
};

/**
 * Fingerprint of what a draft would actually persist. Key-order-insensitive
 * because the payload assembles optional fields through conditional spreads,
 * so an unchanged draft must not look different just because a key moved.
 */
export const playbookDraftFingerprint = (draft: PlaybookDraft): string =>
  stableStringify(buildPlaybookSavePayload(draft));

/**
 * The clean state a draft is compared against: the draft as last persisted
 * (or as first seeded, for a new playbook) plus its fingerprint, computed
 * once and carried together so the two can never disagree.
 */
export type PlaybookBaseline = {
  draft: PlaybookDraft;
  fingerprint: string;
};

export const createPlaybookBaseline = (
  draft: PlaybookDraft,
): PlaybookBaseline => ({
  draft,
  fingerprint: playbookDraftFingerprint(draft),
});

/**
 * Field-wise reference equality. Strings compare by value and `positions` by
 * array identity, which React state preserves until an edit actually
 * replaces it — so an untouched form settles the dirty check without
 * serializing anything.
 */
const isSameDraftReference = (a: PlaybookDraft, b: PlaybookDraft): boolean =>
  a.name === b.name &&
  a.description === b.description &&
  a.documentTypeKey === b.documentTypeKey &&
  a.perspective === b.perspective &&
  a.trigger === b.trigger &&
  a.positions === b.positions;

type HasPlaybookDraftChangesArgs = {
  baseline: PlaybookBaseline;
  current: PlaybookDraft;
};

export const hasPlaybookDraftChanges = ({
  baseline,
  current,
}: HasPlaybookDraftChangesArgs): boolean => {
  if (isSameDraftReference(baseline.draft, current)) {
    return false;
  }
  return playbookDraftFingerprint(current) !== baseline.fingerprint;
};

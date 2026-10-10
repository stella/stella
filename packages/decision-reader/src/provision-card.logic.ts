import { blocksNestedUnder } from "@stll/legal-ast/provision-preview";

import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
} from "./reader-types";

type ProvisionInVersionKey = {
  anchor: string;
  documentId: string;
};

const comparable = (text: string): string =>
  text.normalize("NFC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim();

type ProvisionTrailInput = {
  /** The card's own name for the provision: the citation as written. */
  label: string;
  /** The act, then the part, chapter and division the provision sits under. */
  places: readonly string[];
};

/**
 * Where a cited provision sits, minus what its label already says: a citation
 * that names its act ("§ 2 zákona č. 89/2012 Sb.") does not repeat the act
 * under it, and a heading the label spells out is not shown twice. Empty when
 * nothing is left to add, so the card shows no line for it.
 */
export const informativeProvisionTrail = ({
  label,
  places,
}: ProvisionTrailInput): string[] => {
  const name = comparable(label);
  const seen = new Set<string>();
  const trail: string[] = [];
  for (const place of places) {
    const text = comparable(place);
    if (text === "" || seen.has(text) || name.includes(text)) {
      continue;
    }
    seen.add(text);
    trail.push(place.trim());
  }
  return trail;
};

/** The subdivision a citation names, or the provision heading itself. */
const citedAnchor = ({ payload }: CitedProvisionTarget): string =>
  payload.highlightAnchorId ?? payload.anchorId;

const citesWholeProvision = (target: CitedProvisionTarget): boolean =>
  citedAnchor(target) === target.payload.anchorId;

const provisionInVersion = ({
  document,
  payload,
}: CitedProvisionTarget): ProvisionInVersionKey => ({
  anchor: payload.anchorId,
  documentId: document.id,
});

const isSameProvisionInVersion = (
  left: ProvisionInVersionKey,
  right: ProvisionInVersionKey,
): boolean =>
  left.anchor === right.anchor && left.documentId === right.documentId;

type ProvisionCitation = { id: string; target: CitedProvisionTarget };

/**
 * One paragraph's card for one provision in one consolidation, with every
 * distinct part of it the paragraph cites, in citation order. `id` is the
 * first citation's, stable while the paragraph is.
 */
type ProvisionCardCitations = {
  citations: CitedProvisionTarget[];
  id: string;
  provision: ProvisionInVersionKey;
};

/**
 * A paragraph that cites one provision several times gets one card for it:
 * citations of the same provision in the same applied consolidation share a
 * card, a repeated citation of the same part adds nothing, and a citation of
 * another part adds that part. The same provision applied in another
 * consolidation is another wording, so it keeps a card of its own.
 */
export const provisionCardsOf = (
  citations: readonly ProvisionCitation[],
): ProvisionCardCitations[] => {
  const cards: ProvisionCardCitations[] = [];
  for (const { id, target } of citations) {
    const provision = provisionInVersion(target);
    const card = cards.find((candidate) =>
      isSameProvisionInVersion(candidate.provision, provision),
    );
    if (card === undefined) {
      cards.push({ citations: [target], id, provision });
      continue;
    }
    if (
      card.citations.some((cited) => citedAnchor(cited) === citedAnchor(target))
    ) {
      continue;
    }
    card.citations.push(target);
  }
  return cards;
};

/** How much of its provision a card's citations name. */
export const PROVISION_CARD_SCOPE = {
  /** Some citation names the whole provision: there is nothing more to show. */
  whole: "whole",
  /** Every citation names a part: the rest of the provision folds away. */
  parts: "parts",
} as const;

type ProvisionCardScope =
  (typeof PROVISION_CARD_SCOPE)[keyof typeof PROVISION_CARD_SCOPE];

export const provisionCardScope = (
  citations: readonly CitedProvisionTarget[],
): ProvisionCardScope =>
  citations.some(citesWholeProvision)
    ? PROVISION_CARD_SCOPE.whole
    : PROVISION_CARD_SCOPE.parts;

/** Each distinct label once, in citation order. */
export const provisionCardLabels = (
  citations: readonly CitedProvisionTarget[],
): string[] => [
  ...new Set(citations.map(({ payload }) => payload.provisionLabel)),
];

type ProvisionWordingBlock = ProvisionPreviewData["blocks"][number];

export type CitedWording = {
  target: CitedProvisionTarget;
  /** Undefined while the citation's wording has not been read yet. */
  wording: ProvisionPreviewData | null | undefined;
};

/** A read answers with wording only when it contains text blocks. */
const hasProvisionWording = (
  wording: CitedWording["wording"],
): wording is ProvisionPreviewData =>
  wording !== null && wording !== undefined && wording.blocks.length > 0;

/**
 * What a card quotes before the reader asks for the whole provision. Every
 * block in it is wording some citation names; `cited` marks the blocks a
 * citation of a part names, so a card quoting a whole provision still shows
 * which parts the paragraph pointed at.
 */
export type ProvisionCardPassage =
  | { type: "pending" }
  | {
      type: "passage";
      blocks: ProvisionWordingBlock[];
      cited: ReadonlySet<string>;
      language: string | null;
      /** Distinct labels of quoted citations with no wording or no text blocks. */
      unavailable: string[];
    };

/** What the host's full-provision read answered. */
export type FullProvisionRead = {
  isPending: boolean;
  /** Null while unread, and when the read failed or found nothing. */
  whole: ProvisionPreviewData | null;
};

export type FullProvisionOutcome =
  | { type: "pending" }
  | { type: "text"; wording: ProvisionPreviewData }
  | { type: "unavailable" };

export const fullProvisionOutcome = ({
  isPending,
  whole,
}: FullProvisionRead): FullProvisionOutcome => {
  if (isPending) {
    return { type: "pending" };
  }
  return hasProvisionWording(whole)
    ? { type: "text", wording: whole }
    : { type: "unavailable" };
};

/**
 * The quoted passage of one card. A whole-provision citation quotes the
 * provision as it stands; otherwise the parts follow each other in citation
 * order, a block two of them share drawn once. Pending until every citation
 * has its answer, so the passage never reflows part by part. Unavailable
 * parts (null or empty previews) keep their distinct labels in citation order.
 * When a whole provision is cited, only its wording determines availability.
 * A successful full read supplies the displayed blocks and resolves each cited
 * part by its anchor, preserving notices for parts that read still lacks.
 */
export const provisionCardPassage = (
  wordings: readonly CitedWording[],
  fullWording: ProvisionPreviewData | null = null,
): ProvisionCardPassage => {
  if (wordings.some(({ wording }) => wording === undefined)) {
    return { type: "pending" };
  }
  const full = hasProvisionWording(fullWording) ? fullWording : null;
  const resolved =
    full === null
      ? wordings
      : wordings.map(({ target }) => {
          if (citesWholeProvision(target)) {
            return { target, wording: full };
          }
          const anchor = citedAnchor(target);
          const block = full.blocks.find(
            (candidate) => candidate.anchorId === anchor,
          );
          return {
            target,
            wording:
              block === undefined
                ? null
                : {
                    ...full,
                    blocks: blocksNestedUnder(full.blocks, block),
                  },
          };
        });
  const whole = resolved.find(({ target }) => citesWholeProvision(target));
  const quoted = whole === undefined ? resolved : [whole];
  const unavailable = [
    ...new Set(
      quoted
        .filter(({ wording }) => !hasProvisionWording(wording))
        .map(({ target }) => target.payload.provisionLabel),
    ),
  ];
  const blocks: ProvisionWordingBlock[] = [];
  const seen = new Set<string>();
  let language: string | null = null;
  const displayed =
    full === null ? quoted.map(({ wording }) => wording) : [full];
  for (const wording of displayed) {
    if (!hasProvisionWording(wording)) {
      continue;
    }
    language ??= wording.language;
    for (const block of wording.blocks) {
      if (seen.has(block.id)) {
        continue;
      }
      seen.add(block.id);
      blocks.push(block);
    }
  }
  const cited = new Set<string>();
  for (const { target, wording } of resolved) {
    if (!hasProvisionWording(wording)) {
      continue;
    }
    if (citesWholeProvision(target)) {
      continue;
    }
    for (const block of wording.blocks) {
      cited.add(block.id);
    }
  }
  return { type: "passage", blocks, cited, language, unavailable };
};

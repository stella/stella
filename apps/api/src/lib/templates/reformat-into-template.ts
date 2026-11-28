/**
 * One stored document onto one organisation template: the product layer over
 * `house-style/format-onto-template`. It picks the template when the caller
 * names none, turns the library's refusals into codes a person can act on,
 * and writes the formatting note from the engine's report, never from what a
 * model says it did.
 *
 * Nothing here reads or writes storage: the caller hands in both files and
 * stores the output. A refusal returns no document at all, so a partial or
 * unverified output never reaches a matter.
 */

import { panic, Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";
import { stripUnicodeMarks } from "@stll/text-normalize";

import { arrayOrEmpty } from "@/api/lib/array";
import { resolveAmbiguitiesByRule } from "@/api/lib/templates/house-style/ambiguity";
import type { AmbiguityResolver } from "@/api/lib/templates/house-style/ambiguity";
import { TemplateEngineError } from "@/api/lib/templates/house-style/folio-contract";
import type {
  DocxBlock,
  DocxBlockManifest,
  TemplateEngineRefusal,
  TemplatePlanEngine,
  TrackedChanges,
} from "@/api/lib/templates/house-style/folio-contract";
import {
  formatOntoTemplate,
  TemplateLabelsNotKeptError,
  TemplateProfileRejectedError,
} from "@/api/lib/templates/house-style/format-onto-template";
import type { Formatted } from "@/api/lib/templates/house-style/format-onto-template";
import type { FormattingNoteItem } from "@/api/lib/templates/house-style/plan-builder";
import type { NumberingMode } from "@/api/lib/templates/house-style/plan-numbering";
import {
  HOUSE_STYLE_TEMPLATE_TAG,
  type REFORMAT_NOTE_ITEM_KINDS,
  type REFORMAT_NUMBERING_MODES,
  type REFORMAT_REFUSAL_CODES,
  type REFORMAT_TEMPLATE_HEALTH_KINDS,
  type REFORMAT_TRACKED_CHANGES,
} from "@/api/lib/templates/reformat-into-template-contract";

type ReformatNumberingMode = (typeof REFORMAT_NUMBERING_MODES)[number];

const NUMBERING_MODE = {
  keep_source: "keepSource",
  house_scheme: "houseScheme",
} as const satisfies Record<ReformatNumberingMode, NumberingMode>;

type ReformatRefusalCode = (typeof REFORMAT_REFUSAL_CODES)[number];

/** A block a refusal names, with the text a person finds it by. */
type RefusalDetail = { blockId?: string; text?: string; reason: string };

/** Details kept per refusal; enough to find the first problems. */
const REFUSAL_DETAILS_MAX = 20;

export class ReformatRefusedError extends TaggedError("ReformatRefusedError")<{
  message: string;
  reason: ReformatRefusalCode;
  details: RefusalDetail[];
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/** The refusal of a document whose tracked changes cannot all be kept as
 *  tracked changes; it shares its code with the one that asks for a choice. */
const CHANGES_NOT_KEEPABLE =
  "The document tracks changes that cannot be kept as tracked changes (a moved passage, a changed table cell). Reformat it with the changes accepted or rejected.";
/** The detail that tells the two refusals of that code apart. */
export const CHANGES_NOT_KEEPABLE_REASON = "cannot_keep";

const REFUSAL_MESSAGES = {
  tracked_changes:
    "The document has tracked changes. Choose whether to keep them as tracked changes, accept them or reject them, then reformat it.",
  unsupported_content:
    "The document holds content that cannot be carried onto the template unchanged.",
  label_not_writable:
    "A paragraph's automatic number cannot be kept, so the document was not reformatted.",
  labels_not_kept:
    "The template would not show every number the document shows, so the document was not reformatted.",
  template_profile_rejected:
    "The template's style profile does not fit the template file.",
  verification_failed:
    "The reformatted document could not be verified against the source, so nothing was saved.",
} as const satisfies Record<ReformatRefusalCode, string>;

const refusalCodeOf = (reason: TemplateEngineRefusal): ReformatRefusalCode => {
  switch (reason) {
    case "tracked-changes":
      return "tracked_changes";
    case "unsupported-content":
      return "unsupported_content";
    case "label-not-writable":
      return "label_not_writable";
    // Requests the library repairs by taking them back; one still refused
    // after that, an output that did not hold up against the plan, a file
    // the engine cannot open, or any other refusal: no verified output.
    case "strip-label-mismatch":
    case "merge-invalid":
    case "reference-span-invalid":
    case "reference-target-unplaced":
    case "highlight-span-invalid":
    case "verification-failed":
    case "archive-unreadable":
    case "other":
      return "verification_failed";
    default: {
      reason satisfies never;
      return panic("Unhandled template engine refusal");
    }
  }
};

type ReformatNoteItem = {
  kind: (typeof REFORMAT_NOTE_ITEM_KINDS)[number];
  blockId?: string;
  /** The library's reason, role, region or section start. */
  reason?: string;
  /** The words a person finds the place by: the citation, the label, or
   *  the start of the paragraph. */
  text?: string;
  /** A block the note points to: the provision a suspected citation more
   *  likely means, or the block the source started a page in front of. */
  targetBlockId?: string;
  count?: number;
  highlighted?: boolean;
};

type ReformatTemplateHealth = {
  kind: (typeof REFORMAT_TEMPLATE_HEALTH_KINDS)[number];
  styleId?: string;
  level?: number;
  /** The formatter's name for a finding of kind `other`. */
  reason?: string;
};

/** Note items returned; a long document's remainder is counted. */
const NOTE_ITEMS_MAX = 200;
const EXCERPT_MAX = 120;
/** The start of a paragraph that carries a typed label. */
const LABEL_EXCERPT_MAX = 40;
/** The footnote marker `DocxBlock.text` carries. */
const OBJECT_MARKER = /￼/gu;
const BLANKS = /\s+/gu;

const excerptOf = (text: string, max = EXCERPT_MAX): string => {
  const flat = text
    .replaceAll(OBJECT_MARKER, "")
    .replaceAll(BLANKS, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

export type ReformatNote = {
  numbering: ReformatNumberingMode;
  counts: {
    paragraphsPlaced: number;
    paragraphsOmitted: number;
    paragraphsNumbered: number;
    labelsWrittenAsText: number;
    referencesLinked: number;
    referencesKeptAsText: number;
    referencesHighlighted: number;
    footnotes: number;
    endnotes: number;
    fieldsFrozen: number;
    fillerLeft: number;
    commentsDropped: number;
    sectionBreaksDropped: number;
    repairs: number;
  };
  /** Null where no layout backend measured the pages. */
  pages: { source: number | null; output: number | null };
  items: ReformatNoteItem[];
  itemsOmitted: number;
  templateHealth: ReformatTemplateHealth[];
};

type NoteSource = FormattingNoteItem;

/** The note items this layer words. The formatter grows its note; a kind it
 *  adds reaches the caller as `other` with its name until it is read here. */
const KNOWN_NOTE_KINDS = [
  "referenceUnlinked",
  "referenceSuspected",
  "referenceStale",
  "labelKeptAsText",
  "labelConvertedToText",
  "roleWithoutStyle",
  "articlesSetAsText",
  "pageStartNotKept",
  "pageStartMoved",
  "sectionLayoutNotKept",
  "lineBreakSpacingKept",
  "invisibleEffectsRemoved",
  "templateBlocksKept",
  "pageMarksDropped",
  "pageMarksKept",
  "trackedChangesKept",
  "trackedChangesResolved",
  "fieldsAsText",
  "internalLinksAsText",
] as const satisfies readonly NoteSource["kind"][];

type KnownNoteSource = Extract<
  NoteSource,
  { kind: (typeof KNOWN_NOTE_KINDS)[number] }
>;

const isKnownNoteSource = (item: NoteSource): item is KnownNoteSource =>
  KNOWN_NOTE_KINDS.some((kind) => kind === item.kind);

/** A finding this layer does not word yet, by its name and block. */
const unreadNoteItem = (item: { kind: string }): ReformatNoteItem =>
  "blockId" in item && typeof item.blockId === "string"
    ? { kind: "other", reason: item.kind, blockId: item.blockId }
    : { kind: "other", reason: item.kind };

/** The changes a document tracks in its text: what a view resolves and
 *  what a kept redline carries. */
const changesOf = ({
  insertions,
  deletions,
  moves,
  paragraphMarks,
  tableRows,
}: TrackedChanges): number =>
  insertions + deletions + moves + paragraphMarks + tableRows;

/**
 * What became of the document's tracked changes when they were kept: how
 * many are in the output, how many sat in paragraphs it does not have, and
 * that recorded changes of formatting are not among them.
 */
const keptChangesItems = (
  item: Extract<NoteSource, { kind: "trackedChangesKept" }>,
): ReformatNoteItem[] => [
  {
    kind: "tracked_changes_kept",
    count: Math.max(0, changesOf(item) - item.notCarried),
  },
  ...(item.notCarried > 0
    ? [{ kind: "tracked_changes_not_carried" as const, count: item.notCarried }]
    : []),
  ...(item.formattingChanges > 0
    ? [
        {
          kind: "formatting_changes_not_kept" as const,
          count: item.formattingChanges,
        },
      ]
    : []),
];

const noteItemOf = (
  item: Exclude<NoteSource, { kind: "trackedChangesKept" }>,
  blocks: ReadonlyMap<string, DocxBlock>,
): ReformatNoteItem => {
  if (!isKnownNoteSource(item)) {
    return unreadNoteItem(item);
  }
  const textOf = (blockId: string, start?: number, end?: number) => {
    const block = blocks.get(blockId);
    if (block === undefined) {
      return {};
    }
    const text = excerptOf(block.text.slice(start ?? 0, end));
    return text === "" ? {} : { text };
  };
  switch (item.kind) {
    case "referenceUnlinked":
      return {
        kind: "reference_kept_as_text",
        blockId: item.blockId,
        reason:
          item.targetRenumbered === true ? "targetRenumbered" : item.reason,
        highlighted: item.highlighted,
        ...textOf(item.blockId, item.start, item.end),
      };
    case "referenceSuspected":
      return {
        kind: "reference_suspected",
        blockId: item.blockId,
        targetBlockId: item.suggestedBlockId,
        ...textOf(item.blockId, item.start, item.end),
      };
    case "referenceStale":
      return {
        kind: "reference_stale",
        blockId: item.blockId,
        targetBlockId: item.targetBlockId,
        text: item.shown,
        reason: item.current,
      };
    case "labelKeptAsText":
      return {
        kind: "label_kept_as_text",
        blockId: item.blockId,
        reason: item.reason,
        ...(() => {
          const block = blocks.get(item.blockId);
          const text =
            block === undefined ? "" : excerptOf(block.text, LABEL_EXCERPT_MAX);
          return text === "" ? {} : { text };
        })(),
      };
    case "labelConvertedToText": {
      const label = blocks.get(item.blockId)?.label ?? null;
      return {
        kind: "label_converted_to_text",
        blockId: item.blockId,
        reason: item.reason,
        ...(label === null ? {} : { text: label }),
      };
    }
    case "roleWithoutStyle":
      return {
        kind: "role_without_style",
        reason: item.role,
        count: item.blocks,
      };
    case "articlesSetAsText":
      return { kind: "articles_set_as_text", count: item.blocks };
    case "pageStartNotKept":
      return {
        kind: "page_start_not_kept",
        blockId: item.blockId,
        reason: item.reason,
      };
    case "pageStartMoved":
      return {
        kind: "page_start_moved",
        blockId: item.blockId,
        targetBlockId: item.fromBlockId,
      };
    case "sectionLayoutNotKept":
      return {
        kind: "section_layout_not_kept",
        blockId: item.afterBlockId,
        reason: item.start,
      };
    case "lineBreakSpacingKept":
      return {
        kind: "line_break_spacing_kept",
        reason: item.reason,
        count: item.blocks,
      };
    case "invisibleEffectsRemoved":
      return {
        kind: "invisible_effects_removed",
        count: item.levels + item.styles,
      };
    case "templateBlocksKept":
      return {
        kind: "template_blocks_kept",
        reason: item.region,
        count: item.blockIds.length,
      };
    // The place is named by the first words of the paragraph that held the
    // marks, or of the next one when that paragraph has no words.
    case "pageMarksDropped":
      return {
        kind: "page_marks_dropped",
        blockId: item.blockId,
        count: item.marks,
        ...(item.paragraphOmitted === true
          ? { reason: "paragraph_omitted" }
          : {}),
        ...textOf(item.nearBlockId ?? item.blockId, 0, LABEL_EXCERPT_MAX),
      };
    case "pageMarksKept":
      return {
        kind: "page_marks_kept",
        blockId: item.blockId,
        count: item.marks,
        reason: "signature",
        ...textOf(item.blockId, 0, LABEL_EXCERPT_MAX),
      };
    case "internalLinksAsText":
      return { kind: "internal_links_as_text", count: item.links };
    case "trackedChangesResolved":
      return {
        kind: "tracked_changes_resolved",
        reason: item.view,
        // Accepted or rejected, a change of formatting is resolved too.
        count: changesOf(item) + item.formattingChanges,
      };
    case "fieldsAsText":
      return {
        kind: "fields_as_text",
        reason: item.fields
          .map(({ kind, count }) => `${kind}:${String(count)}`)
          .join(","),
        count: item.fields.reduce((total, { count }) => total + count, 0),
      };
    default: {
      item satisfies never;
      return panic("Unhandled formatting note item");
    }
  }
};

/** The note items one finding of the formatter is worded as. */
const noteItemsOf = (
  item: NoteSource,
  blocks: ReadonlyMap<string, DocxBlock>,
): ReformatNoteItem[] => {
  if (item.kind === "trackedChangesKept") {
    return keptChangesItems(item);
  }
  // One item per header or footer that kept the document's, one per kind
  // of thing that had no place.
  if (item.kind === "sourceHeaders") {
    return [
      ...item.kept.map(
        ({ family, kind, paragraphs, section }): ReformatNoteItem => ({
          kind: "source_header_kept",
          reason: `${family}:${kind}${section === undefined ? "" : `:section${String(section + 1)}`}`,
          count: paragraphs,
        }),
      ),
      ...Object.entries(item.leftOut).flatMap(
        ([reason, count]): ReformatNoteItem[] =>
          count === 0
            ? []
            : [{ kind: "source_header_left_out", reason, count }],
      ),
      ...(item.pageNumbersTwice === undefined || item.pageNumbersTwice === 0
        ? []
        : [
            {
              kind: "source_header_page_number_twice" as const,
              count: item.pageNumbersTwice,
            },
          ]),
    ];
  }
  // The comments kept, and those that had no place.
  if (item.kind === "sourceComments") {
    return [
      ...(item.kept === 0
        ? []
        : [{ kind: "comments_kept" as const, count: item.kept }]),
      ...(item.leftOut === 0
        ? []
        : [{ kind: "comments_left_out" as const, count: item.leftOut }]),
    ];
  }
  // One item per cell of the letterhead that still shows the sample.
  if (item.kind === "letterheadFilled") {
    return item.left.map((cell): ReformatNoteItem => ({
      kind: "letterhead_sample_left",
      reason: cell,
    }));
  }
  return [noteItemOf(item, blocks)];
};

/** The template findings this layer words; a newer one passes as `other`
 *  with its name, as note items do. */
const templateHealthOf = (finding: {
  kind: string;
}): ReformatTemplateHealth => {
  if (finding.kind === "numberDrawnAsPicture") {
    return "ilvl" in finding && typeof finding.ilvl === "number"
      ? { kind: "number_drawn_as_picture", level: finding.ilvl }
      : { kind: "number_drawn_as_picture" };
  }
  if (finding.kind === "textDrawnAsPicture") {
    return "styleId" in finding && typeof finding.styleId === "string"
      ? { kind: "text_drawn_as_picture", styleId: finding.styleId }
      : { kind: "text_drawn_as_picture" };
  }
  if (finding.kind === "rolesNotRead") {
    return { kind: "template_roles_not_read" };
  }
  if (finding.kind === "lastSectionNotBody") {
    return { kind: "template_last_section_not_body" };
  }
  if (finding.kind === "headingStartsPage") {
    return "styleId" in finding && typeof finding.styleId === "string"
      ? { kind: "template_heading_starts_page", styleId: finding.styleId }
      : { kind: "template_heading_starts_page" };
  }
  return { kind: "other", reason: finding.kind };
};

type ReformatOptions = {
  engine: TemplatePlanEngine;
  source: Uint8Array;
  template: Uint8Array;
  numbering: ReformatNumberingMode;
  /** Take the rules' own answer where one candidate clearly leads; otherwise
   *  every open decision stays open and the plan takes the safe path. */
  acceptSuggestedDecisions: boolean;
  /** What to do with the document's tracked changes. Left out, a document
   *  that has any is refused by name: the choice is the caller's. */
  trackedChanges?: (typeof REFORMAT_TRACKED_CHANGES)[number];
};

/** Every open decision left open: a reference stays text, a role as read. */
const leaveDecisionsOpen: AmbiguityResolver = async (items) =>
  // Nothing to wait for; the type is the model step's.
  await Promise.resolve(items.map(({ id }) => ({ id, choice: null })));

/**
 * Formats `source` onto `template`. Returns the output with its note, or the
 * refusal that kept it from being written.
 */
export const reformatDocxOntoTemplate = async ({
  engine,
  source,
  template,
  numbering,
  acceptSuggestedDecisions,
  trackedChanges,
}: ReformatOptions): Promise<
  Result<{ docx: Uint8Array; note: ReformatNote }, ReformatRefusedError>
> => {
  // A formatted document comes back with the source as it was read. A
  // refusal does not, so the last reading is kept for the words a person
  // finds a refused place by.
  let lastRead: DocxBlockManifest | undefined;
  const recording: TemplatePlanEngine = {
    ...engine,
    analyze: async (docx, options) => {
      // The formatter reads a document that tracks changes again as the
      // caller chose. With no choice it is refused by name instead of
      // being formatted with every change accepted.
      if (
        trackedChanges === undefined &&
        options?.trackedChanges !== undefined
      ) {
        return Result.err(
          new TemplateEngineError({
            message: "The document has tracked changes and no view was chosen.",
            reason: "tracked-changes",
          }),
        );
      }
      const analyzed = await engine.analyze(docx, options);
      if (analyzed.isOk()) {
        lastRead = analyzed.value;
      }
      return analyzed;
    },
  };
  const formatted = await formatOntoTemplate({
    engine: recording,
    source,
    template,
    mode: NUMBERING_MODE[numbering],
    resolveAmbiguities: acceptSuggestedDecisions
      ? resolveAmbiguitiesByRule
      : leaveDecisionsOpen,
    ...(trackedChanges === undefined ? {} : { trackedChanges }),
  });
  const read = formatted.isOk() ? formatted.value.manifest : lastRead;
  const blocks = new Map(
    arrayOrEmpty(read?.blocks).map((block) => [block.id, block]),
  );

  if (formatted.isErr()) {
    const { error } = formatted;
    const refuse = (code: ReformatRefusalCode, details: RefusalDetail[]) =>
      Result.err(
        new ReformatRefusedError({
          message: REFUSAL_MESSAGES[code],
          reason: code,
          details: details.slice(0, REFUSAL_DETAILS_MAX),
        }),
      );
    const withText = (blockId: string) => {
      const block = blocks.get(blockId);
      const text =
        block === undefined
          ? ""
          : excerptOf(`${block.label ?? ""} ${block.text}`, LABEL_EXCERPT_MAX);
      return text === "" ? { blockId } : { blockId, text };
    };
    if (error instanceof TemplateLabelsNotKeptError) {
      return refuse(
        "labels_not_kept",
        error.issues.map(({ blockId, kind }) => ({
          ...withText(blockId),
          reason: kind,
        })),
      );
    }
    if (error instanceof TemplateProfileRejectedError) {
      return refuse(
        "template_profile_rejected",
        error.issues.map(({ code, blockId }) => ({
          ...(blockId === undefined ? {} : { blockId }),
          reason: code,
        })),
      );
    }
    // Asked to keep the changes, the engine named some it cannot carry:
    // the choice left is one of the two views.
    if (error.reason === "tracked-changes" && trackedChanges === "keep") {
      return Result.err(
        new ReformatRefusedError({
          message: CHANGES_NOT_KEEPABLE,
          reason: "tracked_changes",
          details: [{ reason: CHANGES_NOT_KEEPABLE_REASON }],
        }),
      );
    }
    // What is left is the engine's own refusal, by its reason.
    return refuse(
      refusalCodeOf(error.reason),
      error.blockId === undefined
        ? []
        : [{ ...withText(error.blockId), reason: error.reason }],
    );
  }

  const done: Formatted = formatted.value;
  const { docx, note, outcome, profile } = done;
  const items = note.items.flatMap((item) => noteItemsOf(item, blocks));
  return Result.ok({
    docx,
    note: {
      numbering,
      counts: {
        paragraphsPlaced: note.counts.placed,
        paragraphsOmitted: note.counts.omitted,
        paragraphsNumbered: note.counts.numbered,
        labelsWrittenAsText: note.counts.labelsConvertedToText,
        referencesLinked: note.counts.referencesLinked,
        referencesKeptAsText: note.counts.referencesUnlinked,
        referencesHighlighted: note.counts.referencesHighlighted,
        footnotes: outcome.footnotes.output,
        endnotes: outcome.endnotes.output,
        fieldsFrozen: outcome.frozenFields,
        fillerLeft: outcome.fillerLeft,
        commentsDropped: outcome.droppedComments,
        sectionBreaksDropped: outcome.droppedSectionBreaks,
        repairs: outcome.repairs.length,
      },
      pages:
        outcome.pages.status === "measured"
          ? { source: outcome.pages.source, output: outcome.pages.output }
          : { source: null, output: null },
      items: items.slice(0, NOTE_ITEMS_MAX),
      itemsOmitted: Math.max(0, items.length - NOTE_ITEMS_MAX),
      templateHealth: arrayOrEmpty(profile.health).map(templateHealthOf),
    },
  });
};

type TemplateCandidate = {
  id: string;
  name: string;
  tags: readonly string[] | null;
  whenToUse: string | null;
  whenNotToUse: string | null;
};

export type TemplateSelection<TCandidate extends TemplateCandidate> =
  | { status: "selected"; template: TCandidate }
  | { status: "none" }
  | { status: "ambiguous"; candidates: TCandidate[] };

const WORD = /[\p{L}\p{N}]{3,}/gu;

const wordsOf = (text: string | null): Set<string> => {
  const words = stripUnicodeMarks(text ?? "", {
    form: "NFD",
    markClass: "combining",
  })
    .toLowerCase()
    .match(WORD);
  return words === null ? new Set() : new Set(words);
};

const sharedWords = (left: Set<string>, right: Set<string>): number => {
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared;
};

/**
 * The house-style template for a document when the caller names none: the
 * only candidate, or the one whose name, tags and usage guidance share the
 * most words with the document's name, ahead of every other. A tie, or no
 * word in common among several, is answered with the candidates; a guess
 * would format a document onto another firm's or department's look.
 */
export const selectHouseStyleTemplate = <TCandidate extends TemplateCandidate>({
  candidates,
  documentName,
}: {
  candidates: readonly TCandidate[];
  documentName: string;
}): TemplateSelection<TCandidate> => {
  const words = wordsOf(documentName);
  const usable = candidates.filter(
    ({ whenNotToUse }) => sharedWords(words, wordsOf(whenNotToUse)) === 0,
  );
  const [only] = usable;
  if (only === undefined) {
    return { status: "none" };
  }
  if (usable.length === 1) {
    return { status: "selected", template: only };
  }
  const scored = usable
    .map((template) => ({
      template,
      score: sharedWords(
        words,
        wordsOf(
          [
            template.name,
            // Every candidate carries the marker tag; it tells none apart.
            ...arrayOrEmpty(template.tags).filter(
              (tag) => tag !== HOUSE_STYLE_TEMPLATE_TAG,
            ),
            template.whenToUse ?? "",
          ].join(" "),
        ),
      ),
    }))
    .toSorted((left, right) => right.score - left.score);
  const [first, second] = scored;
  if (
    first !== undefined &&
    first.score > 0 &&
    (second === undefined || first.score > second.score)
  ) {
    return { status: "selected", template: first.template };
  }
  return { status: "ambiguous", candidates: [...usable] };
};

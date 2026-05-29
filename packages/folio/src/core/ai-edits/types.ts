import type { FolioBlockId } from "../types/block-id";

export type FolioAIBlockKind = "heading" | "listItem" | "paragraph";

export type FolioAIBlockPreviewRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
};

export type FolioAIBlock = {
  id: FolioBlockId;
  kind: FolioAIBlockKind;
  text: string;
  displayLabel?: string;
  styleId?: string;
  previewRuns?: FolioAIBlockPreviewRun[];
};

export type FolioAIEditSnapshot = {
  blocks: FolioAIBlock[];
  anchors: Record<FolioBlockId, FolioAIBlockAnchor>;
};

export type FolioAIBlockAnchor = {
  id: FolioBlockId;
  from: number;
  to: number;
  text: string;
  normalizedText: string;
  textHash: string;
  hashOccurrenceCount: number;
};

export type FolioAIComment = {
  text: string;
};

export type FolioAIEditSeverity = "low" | "medium" | "high";

/**
 * Optional review metadata attached to an AI-authored operation.
 * Set by the model when performing a structured review (e.g.
 * `severity: "high"`, `area: "Penalty"`); absent for direct edits.
 * Both fields are independent — either or both may be set.
 */
export type FolioAIEditReviewMeta = {
  severity?: FolioAIEditSeverity;
  area?: string;
};

/**
 * A party in an `insertSignatureTable` op. Mirrors the
 * `signatureTable` helper in `docx-core/legal-source/compile.ts`:
 * name is rendered bold; `signatory` and `title` are optional
 * lines under the signature rule (title in italics).
 */
export type FolioAISignatureParty = {
  name: string;
  signatory?: string;
  title?: string;
};

export type FolioAIEditOperation = FolioAIEditReviewMeta &
  (
    | {
        id: string;
        type: "replaceInBlock";
        blockId: FolioBlockId;
        find: string;
        replace: string;
        comment?: FolioAIComment;
      }
    | {
        id: string;
        type: "insertAfterBlock" | "insertBeforeBlock";
        blockId: FolioBlockId;
        text: string;
        inheritFormatting?: boolean;
        /**
         * When true, mark the inserted paragraph with
         * `pageBreakBefore` so the layout engine starts it on a
         * new page. Use for explicit page-break inserts.
         */
        pageBreakBefore?: boolean;
        /**
         * Override the paragraph `styleId` attr of the inserted
         * block (e.g. `ClauseHeading1`). When omitted the inserted
         * block inherits the source block's styleId via
         * `inheritFormatting`.
         */
        styleId?: string;
        comment?: FolioAIComment;
      }
    | {
        id: string;
        type: "replaceBlock";
        blockId: FolioBlockId;
        text: string;
        preserveFormatting?: boolean;
        styleId?: string;
        comment?: FolioAIComment;
      }
    | {
        id: string;
        type: "deleteBlock";
        blockId: FolioBlockId;
        comment?: FolioAIComment;
      }
    | {
        id: string;
        type: "commentOnBlock";
        blockId: FolioBlockId;
        quote?: string;
        comment: FolioAIComment;
      }
    | {
        id: string;
        type: "insertSignatureTable";
        blockId: FolioBlockId;
        /**
         * Position the table after the anchor block (default) or
         * before it. Always inserts as a sibling at the document
         * level — no nested-table support.
         */
        position?: "after" | "before";
        parties: FolioAISignatureParty[];
        comment?: FolioAIComment;
      }
  );

export type FolioAIEditApplyMode = "direct" | "tracked-changes";

export type FolioAIEditSkipReason =
  | "missingBlock"
  | "changedBlock"
  | "ambiguousFind"
  | "missingFind"
  | "unsupportedBlock"
  | "emptyOperation"
  /**
   * The operation would not change the document — find equals
   * replace, or replaceBlock's `text` matches the live block.
   * Filtered out so the reviewer doesn't see "X → X" cards.
   */
  | "noopOperation";

export type FolioAIEditAppliedOperation = {
  id: string;
  commentId?: number;
  /**
   * Primary tracked-change revision id (only set when applied in
   * `tracked-changes` mode and the operation produced at least one
   * insertion/deletion mark). Stable identifier suitable for
   * scroll-to and visual reference.
   */
  revisionId?: number;
  /**
   * Every revision id this operation produced. A replace allocates
   * separate ids for the deletion and the insertion sides because
   * fromProseDoc serialises a single id carrying both as a Word
   * "moveTo/moveFrom" pair, not an ins/del — so the two sides must
   * be distinct ids in the doc but conceptually one operation here.
   * Use this list when you need to accept or reject every mark
   * belonging to this op.
   */
  revisionIds?: readonly number[];
};

export type FolioAIEditSkippedOperation = {
  id: string;
  reason: FolioAIEditSkipReason;
};

export type FolioAIEditApplyResult = {
  applied: FolioAIEditAppliedOperation[];
  skipped: FolioAIEditSkippedOperation[];
};

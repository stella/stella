/**
 * Spec → in-document AISuggestion mapping for the Template Studio chat.
 *
 * Turns (literal -> replacement) specs — derived from
 * `suggest_changes` tool operations — into one AISuggestion per
 * occurrence of each literal. Occurrences and their context windows come
 * from the same positional-text model the staleness resolver searches
 * (`buildPositionalText`, blocks joined with "\n") — contexts built any
 * other way fail to re-anchor after the first edit and the suggestions
 * all go stale. One suggestion per span: first spec wins per occupied
 * range.
 */

import { panic } from "better-result";
import type { Node as PMNode } from "prosemirror-model";

import type {
  FolioAIEditOperation,
  FolioAIEditSeverity,
  FolioAIEditSkipReason,
} from "@stll/folio-core/ai-edits";
import { buildPositionalText } from "@stll/folio-react";
import type { AISuggestion } from "@stll/folio-react";
import { stableStringify } from "@stll/stable-stringify";
import { isFieldPath } from "@stll/template-conditions";

/** Chars of surrounding text recorded so suggestions survive document edits
 *  (the host re-anchors stale ranges via contextBefore/After). */
const CONTEXT_CHARS = 24;

export type ReplacementSpec = {
  /** Caller identity (the tool operation id) — echoed in `placedSpecIds`. */
  id: string;
  literalText: string;
  suggestedText: string;
  topic: string;
  rationale: string;
  /** Badges describing the suggestion's payload (field flow only). */
  display?: AISuggestion["display"];
  /** Registers metadata for each created suggestion id (field flow only). */
  registerMeta?: (suggestionId: string) => void;
  /**
   * Plain text of the snapshot block the operation targeted. When it can
   * be located in the live document, the literal search is confined to
   * that region (mirrors `replaceInBlock` semantics); otherwise the whole
   * document is searched.
   */
  scopeText?: string;
};

export type BuildReplacementSuggestionsResult = {
  suggestions: AISuggestion[];
  /** Ids of specs that produced at least one in-document suggestion. */
  placedSpecIds: Set<string>;
};

export type BuildReplacementSuggestionsOptions = {
  /**
   * Ranges already claimed by existing pending suggestions; new
   * suggestions never overlap them. Progressive (streamed) placement
   * passes the current pending set so a later batch cannot double-mark
   * a span an earlier batch already covered.
   */
  occupiedRanges?: readonly { from: number; to: number }[];
};

export const buildReplacementSuggestions = (
  doc: PMNode,
  specs: readonly ReplacementSpec[],
  options?: BuildReplacementSuggestionsOptions,
): BuildReplacementSuggestionsResult => {
  const positional = buildPositionalText(doc);
  const haystack = positional.text;
  const suggestions: AISuggestion[] = [];
  const placedSpecIds = new Set<string>();
  const occupied: { from: number; to: number }[] = options?.occupiedRanges
    ? [...options.occupiedRanges]
    : [];

  for (const spec of specs) {
    if (spec.literalText.length === 0) {
      continue;
    }

    let regionStart = 0;
    let regionEnd = haystack.length;
    if (spec.scopeText !== undefined && spec.scopeText.length > 0) {
      const scopeIdx = haystack.indexOf(spec.scopeText);
      if (scopeIdx !== -1) {
        regionStart = scopeIdx;
        regionEnd = scopeIdx + spec.scopeText.length;
      }
    }

    let idx = haystack.indexOf(spec.literalText, regionStart);
    while (idx !== -1 && idx + spec.literalText.length <= regionEnd) {
      const from = positional.pmPositionAt(idx);
      const to = positional.pmPositionAt(idx + spec.literalText.length - 1) + 1;
      const overlaps = occupied.some((r) => from < r.to && to > r.from);
      if (!overlaps) {
        occupied.push({ from, to });
        const id = crypto.randomUUID();
        spec.registerMeta?.(id);
        placedSpecIds.add(spec.id);
        const suggestion: AISuggestion = {
          id,
          topic: spec.topic,
          severity: "substantive",
          range: { from, to },
          originalText: spec.literalText,
          suggestedText: spec.suggestedText,
          contextBefore: haystack.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
          contextAfter: haystack.slice(
            idx + spec.literalText.length,
            idx + spec.literalText.length + CONTEXT_CHARS,
          ),
          rationale: spec.rationale,
          status: "pending",
        };
        if (spec.display !== undefined) {
          suggestion.display = spec.display;
        }
        suggestions.push(suggestion);
      }
      idx = haystack.indexOf(spec.literalText, idx + spec.literalText.length);
    }
  }

  return {
    suggestions: suggestions.toSorted((a, b) => a.range.from - b.range.from),
    placedSpecIds,
  };
};

type TemplateEditOperationMeta = {
  /** folio's operation id once parsed; absent on ops read from the input stream. */
  id?: string;
  blockId: string;
  comment?: { text: string };
  severity?: FolioAIEditSeverity;
  area?: string;
};

/**
 * The operations the Studio renders as text replacements: the
 * `suggest_changes` subset its surface registers. Ops read from the
 * streaming tool input and ops parsed by folio both project onto it.
 */
export type DocxEditOperation =
  | (TemplateEditOperationMeta & {
      type: "replaceInBlock";
      find: string;
      replace: string;
    })
  | (TemplateEditOperationMeta & { type: "replaceBlock"; text: string })
  | (TemplateEditOperationMeta & { type: "deleteBlock" });

type SkippedOperation = { id: string; reason: FolioAIEditSkipReason };

/**
 * Project a folio-parsed operation onto the Studio subset; null for a kind
 * the Studio cannot render (the tool schema excludes them, so this only
 * guards a contract that widens later).
 */
export const toTemplateEditOperation = (
  operation: FolioAIEditOperation,
): DocxEditOperation | null => {
  const meta: TemplateEditOperationMeta = {
    id: operation.id,
    blockId:
      "blockId" in operation ? operation.blockId : operation.range.blockId,
    ...(operation.severity !== undefined && { severity: operation.severity }),
    ...(operation.area !== undefined && { area: operation.area }),
  };
  switch (operation.type) {
    case "replaceInBlock":
      return {
        ...meta,
        ...(operation.comment !== undefined && { comment: operation.comment }),
        type: operation.type,
        find: operation.find,
        replace: operation.replace,
      };
    case "replaceBlock":
      return {
        ...meta,
        ...(operation.comment !== undefined && { comment: operation.comment }),
        type: operation.type,
        text: operation.text,
      };
    case "deleteBlock":
      return {
        ...meta,
        ...(operation.comment !== undefined && { comment: operation.comment }),
        type: operation.type,
      };
    // Outside the Studio subset: it renders a suggestion as a text
    // replacement inside one block, and none of these is one. A structural
    // edit (a paragraph split or joined, a table added or removed, a
    // paragraph restyled) has no in-block replacement to show.
    case "replaceRange":
    case "commentOnRange":
    case "formatRange":
    case "setBlockParagraphProperties":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "splitBlock":
    case "mergeBlockWithNext":
    case "commentOnBlock":
    case "insertSignatureTable":
    case "insertTable":
    case "deleteTable":
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
      return null;
    default:
      operation satisfies never;
      return panic(`Unhandled operation: ${String(operation)}`);
  }
};

const operationAnchorBlockId = (operation: DocxEditOperation): string =>
  operation.blockId;

/** Stable per-operation id echoed to the model in queued/skipped: the
 *  model-supplied contract id when present, else a positional fallback. */
export const operationSpecId = (
  operation: DocxEditOperation,
  index: number,
): string =>
  operation.id ??
  `tpl-edit-${String(index + 1)}-${operationAnchorBlockId(operation)}`;

export type BuildReplaceSpecArgs = {
  id: string;
  find: string;
  replace: string;
  /** Snapshot text of the targeted block; undefined widens the literal
   *  search to the whole document. */
  scopeText: string | undefined;
  comment: string | undefined;
  area: string;
};

export type BuildOperationSpecsOptions = {
  operations: readonly DocxEditOperation[];
  /** Index of `operations[0]` within the full tool input, so spec ids
   *  stay stable when ops are processed in sub-batches. */
  startIndex?: number;
  /** Snapshot block text by id; the ops' `find`/scope texts were
   *  written against these. */
  blockTextById: ReadonlyMap<string, string>;
  /** Builds the replacement spec for replace-type ops; the caller owns
   *  the field-proposal enrichment (badges, accept-time registration)
   *  so this module stays pure. */
  buildReplaceSpec: (args: BuildReplaceSpecArgs) => ReplacementSpec;
};

export type BuildOperationSpecsResult = {
  specs: ReplacementSpec[];
  skipped: SkippedOperation[];
};

/**
 * `suggest_changes` operations → replacement specs.
 *
 * A `replaceInBlock` whose blockId matches no snapshot block is NOT
 * rejected: the op still carries the literal to find, so the spec is
 * built without `scopeText` and the search degrades to the whole
 * document (stale snapshot refs and editor remounts must not discard
 * otherwise-anchorable edits). `replaceBlock`/`deleteBlock` need the
 * block's text as the search literal, so those do skip when the block
 * reference cannot be resolved.
 */
export const buildOperationSpecs = ({
  operations,
  startIndex = 0,
  blockTextById,
  buildReplaceSpec,
}: BuildOperationSpecsOptions): BuildOperationSpecsResult => {
  const specs: ReplacementSpec[] = [];
  const skipped: SkippedOperation[] = [];

  for (const [offset, operation] of operations.entries()) {
    const id = operationSpecId(operation, startIndex + offset);
    const blockText = blockTextById.get(operationAnchorBlockId(operation));
    const commentText = operation.comment?.text;
    switch (operation.type) {
      case "replaceInBlock": {
        if (operation.find === operation.replace) {
          skipped.push({ id, reason: "noopOperation" });
          break;
        }
        specs.push(
          buildReplaceSpec({
            id,
            find: operation.find,
            replace: operation.replace,
            scopeText: blockText,
            comment: commentText,
            area: operation.area ?? "",
          }),
        );
        break;
      }
      case "replaceBlock": {
        if (blockText === undefined) {
          skipped.push({ id, reason: "missingBlock" });
          break;
        }
        if (operation.text === blockText) {
          skipped.push({ id, reason: "noopOperation" });
          break;
        }
        specs.push(
          buildReplaceSpec({
            id,
            find: blockText,
            replace: operation.text,
            scopeText: blockText,
            comment: commentText,
            area: operation.area ?? "",
          }),
        );
        break;
      }
      case "deleteBlock": {
        if (blockText === undefined) {
          skipped.push({ id, reason: "missingBlock" });
          break;
        }
        specs.push({
          id,
          literalText: blockText,
          suggestedText: "",
          topic: commentText ?? operation.area ?? "",
          rationale: commentText ?? "",
          scopeText: blockText,
        });
        break;
      }
      default: {
        operation satisfies never;
        panic(`Unhandled operation: ${String(operation)}`);
      }
    }
  }

  return { specs, skipped };
};

/**
 * Completed operations from a partially streamed tool input. The AI
 * SDK exposes incremental partial-JSON parses of the call input while
 * it streams; every element of `operations` except the last is
 * structurally complete JSON, so those are safe to act on before the
 * call finishes. Elements are still shape-checked (the tool schema
 * only runs once the input is complete) and extraction stops at the
 * first malformed element so indices stay aligned with the final
 * validated input.
 */
export const extractCompletedStreamingOperations = (
  input: unknown,
): DocxEditOperation[] => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("operations" in input) ||
    !Array.isArray(input.operations)
  ) {
    return [];
  }
  const completed = input.operations.slice(0, -1);
  const operations: DocxEditOperation[] = [];
  for (const candidate of completed) {
    if (!isStreamedOperation(candidate)) {
      break;
    }
    operations.push(normalizeStreamedComment(candidate));
  }
  return operations;
};

/**
 * The tool contract lets the model write `comment` as a plain string (folio's
 * parser wraps it into `{ text }`); a streamed op is read before that parse,
 * so wrap it here or the fingerprint never matches the parsed counterpart.
 */
const normalizeStreamedComment = (
  operation: DocxEditOperation,
): DocxEditOperation => {
  const comment: unknown = Reflect.get(operation, "comment");
  return typeof comment === "string"
    ? { ...operation, comment: { text: comment } }
    : operation;
};

const OPERATION_SEVERITIES: readonly string[] = Object.freeze([
  "low",
  "medium",
  "high",
]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStreamedOperation = (value: unknown): value is DocxEditOperation => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type: unknown = Reflect.get(value, "type");
  const severity: unknown = Reflect.get(value, "severity");
  if (
    !isNonEmptyString(Reflect.get(value, "blockId")) ||
    !isNonEmptyString(Reflect.get(value, "area")) ||
    typeof severity !== "string" ||
    !OPERATION_SEVERITIES.includes(severity)
  ) {
    return false;
  }
  switch (type) {
    case "replaceInBlock":
      return (
        isNonEmptyString(Reflect.get(value, "find")) &&
        typeof Reflect.get(value, "replace") === "string"
      );
    case "replaceBlock":
      return typeof Reflect.get(value, "text") === "string";
    case "deleteBlock":
      return true;
    default:
      return false;
  }
};

/**
 * Fingerprint of what a placement depends on, so an operation captured
 * from the input stream and its folio-parsed counterpart compare equal:
 * the parsed op carries a minted id and a wrapped comment the streamed
 * one lacks, so only the placement-relevant fields take part. A mismatch
 * means the finalized op no longer matches what was provisionally placed
 * and the provisional suggestion must be replaced.
 */
export const operationFingerprint = (operation: DocxEditOperation): string =>
  stableStringify({
    type: operation.type,
    blockId: operation.blockId,
    severity: operation.severity ?? null,
    area: operation.area ?? null,
    comment: operation.comment?.text ?? null,
    find: operation.type === "replaceInBlock" ? operation.find : null,
    replace: operation.type === "replaceInBlock" ? operation.replace : null,
    text: operation.type === "replaceBlock" ? operation.text : null,
  });

/**
 * Field metadata recovered for a replacement whose `replace` text is a
 * single `{{field.path}}` marker, joined from the latest
 * `suggest_template_fields` tool output.
 */
export type SuggestedFieldMeta = {
  path: string;
  inputType?: string | undefined;
  label?: string | undefined;
  aiPrompt?: string | undefined;
};

/**
 * The field path when `text` is exactly one `{{path}}` marker (the shape
 * the model is told to use when wrapping a literal as a field), else null.
 * Path validity defers to the marker grammar's `isFieldPath`.
 */
export const extractFieldMarkerPath = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) {
    return null;
  }
  const inner = trimmed.slice(2, -2).trim();
  return isFieldPath(inner) ? inner : null;
};

/** Mirrors the Studio inspector's who-fills derivation: a drafting prompt
 *  means AI fills the value, else a person does. (The chat tool does not
 *  propose person+AI adaptation; that stays a manual setting.) */
export const filledByForFieldMeta = (
  meta: SuggestedFieldMeta,
): NonNullable<NonNullable<AISuggestion["display"]>["filledBy"]> =>
  meta.aiPrompt === undefined ? "person" : "ai";

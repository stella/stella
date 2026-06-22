/**
 * Spec → in-document AISuggestion mapping for the Template Studio chat.
 *
 * Turns (literal -> replacement) specs — derived from
 * `apply-active-docx-edits` tool operations — into one AISuggestion per
 * occurrence of each literal. Occurrences and their context windows come
 * from the same positional-text model the staleness resolver searches
 * (`buildPositionalText`, blocks joined with "\n") — contexts built any
 * other way fail to re-anchor after the first edit and the suggestions
 * all go stale. One suggestion per span: first spec wins per occupied
 * range.
 */

import type { Node as PMNode } from "prosemirror-model";

import { buildPositionalText } from "@stll/folio";
import type { AISuggestion } from "@stll/folio";
import { isFieldPath } from "@stll/template-conditions";

import type {
  ApplyActiveDocxEditsInput,
  ApplyActiveDocxEditsOutput,
} from "@/routes/_protected.chat/-queries";

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
  const occupied: { from: number; to: number }[] = [
    ...(options?.occupiedRanges ?? []),
  ];

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

export type DocxEditOperation = ApplyActiveDocxEditsInput["operations"][number];

type SkippedOperation = ApplyActiveDocxEditsOutput["skipped"][number];

/** Stable per-operation id echoed to the model in queued/skipped. */
export const operationSpecId = (
  operation: DocxEditOperation,
  index: number,
): string => `tpl-edit-${String(index + 1)}-${operation.blockId}`;

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
 * `apply-active-docx-edits` operations → replacement specs.
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
    const blockText = blockTextById.get(operation.blockId);
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
            comment: operation.comment?.text,
            area: operation.area,
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
            comment: operation.comment?.text,
            area: operation.area,
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
          topic: operation.comment?.text ?? operation.area,
          rationale: operation.comment?.text ?? "",
          scopeText: blockText,
        });
        break;
      }
      // The Studio renders suggestions as text replacements over the
      // live document; structural inserts and comments have no such
      // representation here. The prompt steers the model away from
      // them; skip defensively when it emits one anyway.
      case "insertAfterBlock":
      case "insertBeforeBlock":
      case "commentOnBlock":
      case "insertSignatureTable": {
        skipped.push({ id, reason: "unsupportedBlock" });
        break;
      }
      default: {
        operation satisfies never;
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
    operations.push(candidate);
  }
  return operations;
};

const OPERATION_SEVERITIES = new Set(["low", "medium", "high"]);

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
    !OPERATION_SEVERITIES.has(severity)
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
    case "insertAfterBlock":
    case "insertBeforeBlock":
      return typeof Reflect.get(value, "text") === "string";
    case "deleteBlock":
      return true;
    case "commentOnBlock": {
      const comment: unknown = Reflect.get(value, "comment");
      return (
        typeof comment === "object" &&
        comment !== null &&
        isNonEmptyString(Reflect.get(comment, "text"))
      );
    }
    case "insertSignatureTable": {
      const parties: unknown = Reflect.get(value, "parties");
      return Array.isArray(parties) && parties.length > 0;
    }
    default:
      return false;
  }
};

/**
 * Key-order-insensitive fingerprint, so an operation captured from the
 * input stream and its final schema-validated counterpart compare
 * equal. A mismatch means the finalized op no longer matches what was
 * provisionally placed (e.g. the schema stripped a stray key), and the
 * provisional suggestion must be replaced.
 */
export const operationFingerprint = (operation: DocxEditOperation): string =>
  stableStringify(operation);

const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(Reflect.get(value, key))}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

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

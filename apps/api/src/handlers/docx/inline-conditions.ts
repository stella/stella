/**
 * Inline conditional spans:
 * `{{#if expr}} … {{#elseif expr}} … {{#else}} … {{/if}}` WITHIN one
 * paragraph's text. Block-level processing only recognizes directives that
 * own a whole paragraph; legal drafting also needs conditional phrases:
 * "the Buyer{{#if hasSpouse}} and their spouse{{/if}} hereby…".
 *
 * Runs after {@link processBlockDirectives} (whole-paragraph directives and
 * loop expansion are settled, so every surviving paragraph is final) and
 * before serialization — i.e. before numbering, placeholder discovery, and
 * `{{path}}` substitution in the fill pipeline. See the call site in
 * patch-template.ts for the full ordering rationale.
 *
 * V1 rules (deliberate; violations surface as TemplateStructureError):
 * - Inline ifs and inline eachs do not nest: a second `{{#if}}`/`{{#each}}`
 *   while an inline span is already open in the same paragraph is a structure
 *   error. In particular an inline-each body may contain `{{path.field}}`
 *   placeholders but not inline conditionals (and vice versa).
 * - Inline `{{#each path}} … {{/each}}` wraps a mid-paragraph span: the array
 *   at `path` is read from the top-level data and the content span is repeated
 *   once per item, with each item's `{{path.field}}` references resolved to
 *   that item's values (the same synthetic-key rewrite the block loop uses,
 *   shared via rewriteEachPlaceholdersInText/registerItemPatchValues). The
 *   span's run sequence is deep-cloned per item, so run-level formatting
 *   authored inside the body (bold/italic/etc.) is preserved in every expanded
 *   copy. Author separators written inside the span (", " etc.) are part of the
 *   runs and repeat with it; an empty array removes the whole
 *   `{{#each}}…{{/each}}` span.
 * - An inline if/each must open and close within the same paragraph: an opener
 *   without a closer, or a closer/`{{#elseif}}`/`{{#else}}` without an
 *   opener, is a structure error naming the paragraph (index + excerpt).
 * - `{{#elseif}}` and `{{#else}}` follow block semantics: the first branch
 *   whose condition holds wins; `{{#else}}` always wins when reached.
 * - A paragraph with a structure error is left untouched (its markers stay
 *   in the output) and only the first error per paragraph is reported.
 * - Conditions and array paths evaluate against the top-level template data
 *   plus the manifest's named conditions — the same context as a top-level
 *   block `{{#if}}`/`{{#each}}`. Inline directives do NOT see an enclosing
 *   block-loop iteration item: block loop expansion has already run when this
 *   pass executes.
 * - Like block directives, this pass covers word/document.xml only (not
 *   headers/footers), matching processBlockDirectives.
 *
 * Whole-paragraph directive lines are skipped here: they are the block
 * engine's domain, and orphaned ones were already reported by
 * parseBlockTree — re-reporting them as inline errors would double up.
 * Reported paragraph indices are positions after block processing mutated
 * the body (branch removal, loop expansion).
 *
 * The marker grammar comes from `@stll/template-conditions` (the canonical
 * `scanMarkers`); the run-splitting mechanics come from rich-patch.ts
 * (`replaceParagraphTextRanges`) — nothing is redefined here.
 */

import type * as slimdom from "slimdom";

import {
  assertNever,
  blockDirectiveLinePattern,
  evaluateCondition,
  hasBlockDirectivePattern,
  type NamedCondition,
  resolvePath,
  scanMarkers,
} from "@stll/template-conditions";

import {
  collectNumKeysInText,
  eachKey,
  registerItemPatchValues,
  rewriteEachPlaceholdersInText,
  rewriteIterationTokensInText,
  scopeIterationNumberingInText,
} from "./block-directives";
import { W_NS } from "./ooxml";
import {
  expandInlineEachRuns,
  paragraphSpanText,
  replaceParagraphTextRanges,
  replacePlaceholdersInText,
} from "./rich-patch";
import type { RichPatchValue, TemplateStructureError } from "./types";

/** Mirrors the block engine's IfBranch: `condition === ""` is the
 *  always-true else branch. Offsets index the paragraph's span text. */
type InlineBranch = {
  condition: string;
  contentStart: number;
  contentEnd: number;
};

type InlineIfGroup = {
  kind: "if";
  /** Offset of the opener's `{{`. */
  start: number;
  /** Offset just past the closer's `}}`. */
  end: number;
  branches: InlineBranch[];
};

/** A mid-paragraph `{{#each path}} … {{/each}}` span. */
type InlineEachGroup = {
  kind: "each";
  arrayPath: string;
  /** Offset of the opener's `{{`. */
  start: number;
  /** Offset just past the closer's `}}`. */
  end: number;
  /** Offset just past the opener's `}}` — start of the repeated span. */
  contentStart: number;
  /** Offset of the closer's `{{` — end of the repeated span. */
  contentEnd: number;
};

type InlineGroup = InlineIfGroup | InlineEachGroup;

type InlineParse =
  | { ok: true; groups: InlineGroup[] }
  | { ok: false; message: string; directive: string };

/** Narrow `unknown` to a non-array string-keyed record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const EXCERPT_LENGTH = 60;

/** Short paragraph excerpt so a structure error names the paragraph. */
const excerpt = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, EXCERPT_LENGTH)}…`;
};

/**
 * Parse one paragraph's span text into inline-if groups, enforcing the V1
 * rules above. Returns the first violation (offsets after it are ambiguous,
 * so the caller leaves the whole paragraph untouched).
 */
export const parseInlineConditions = (text: string): InlineParse => {
  const groups: InlineGroup[] = [];
  // At most one inline directive (if OR each) is open at a time; they do not
  // nest within a paragraph (see V1 rules).
  let openIf: {
    raw: string;
    start: number;
    branches: InlineBranch[];
    condition: string;
    contentStart: number;
  } | null = null;
  let openEach: {
    raw: string;
    start: number;
    arrayPath: string;
    contentStart: number;
  } | null = null;

  const fail = (message: string, directive: string): InlineParse => ({
    ok: false,
    message: `${message} in paragraph "${excerpt(text)}"`,
    directive,
  });

  for (const marker of scanMarkers(text)) {
    const { meta } = marker;
    switch (meta.kind) {
      case "placeholder":
      case "clause":
      case "num":
      case "ref":
      case "index":
      case "count":
        break;
      case "if":
        if (openIf || openEach) {
          return fail("Nested inline {{#if}} is not supported", marker.raw);
        }
        openIf = {
          raw: marker.raw,
          start: marker.start,
          branches: [],
          condition: meta.expr,
          contentStart: marker.end,
        };
        break;
      case "each":
        if (openIf || openEach) {
          return fail("Nested inline {{#each}} is not supported", marker.raw);
        }
        openEach = {
          raw: marker.raw,
          start: marker.start,
          arrayPath: meta.expr,
          contentStart: marker.end,
        };
        break;
      case "elseif":
      case "else":
        if (!openIf) {
          return fail(
            `Orphaned inline ${marker.raw} without an open {{#if}}`,
            marker.raw,
          );
        }
        openIf.branches.push({
          condition: openIf.condition,
          contentStart: openIf.contentStart,
          contentEnd: marker.start,
        });
        openIf.condition = meta.kind === "elseif" ? meta.expr : "";
        openIf.contentStart = marker.end;
        break;
      case "endif":
        if (!openIf) {
          return fail(
            "Orphaned inline {{/if}} without an open {{#if}}",
            marker.raw,
          );
        }
        openIf.branches.push({
          condition: openIf.condition,
          contentStart: openIf.contentStart,
          contentEnd: marker.start,
        });
        groups.push({
          kind: "if",
          start: openIf.start,
          end: marker.end,
          branches: openIf.branches,
        });
        openIf = null;
        break;
      case "endeach":
        if (!openEach) {
          return fail(
            "Orphaned inline {{/each}} without an open {{#each}}",
            marker.raw,
          );
        }
        groups.push({
          kind: "each",
          arrayPath: openEach.arrayPath,
          start: openEach.start,
          end: marker.end,
          contentStart: openEach.contentStart,
          contentEnd: marker.start,
        });
        openEach = null;
        break;
      default:
        assertNever(meta);
    }
  }

  if (openIf) {
    return fail(
      "Unclosed inline {{#if}} — the {{/if}} must be in the same paragraph",
      openIf.raw,
    );
  }
  if (openEach) {
    return fail(
      "Unclosed inline {{#each}} — the {{/each}} must be in the same paragraph",
      openEach.raw,
    );
  }

  return { ok: true, groups };
};

/**
 * Resolve inline conditional spans in every paragraph of `body` (including
 * table cells). Mutates the DOM: the winning `{{#if}}` branch's content stays
 * with its original runs/formatting, the markers and losing branches are cut
 * across split runs; an `{{#each}}` span's body run sequence is deep-cloned per
 * item (preserving run formatting) and spliced in over the marker span. Returns
 * structural errors; erroring paragraphs are left untouched.
 */
export const processInlineConditions = (
  body: slimdom.Element,
  data: Record<string, unknown>,
  namedConditions?: NamedCondition[],
): TemplateStructureError[] => {
  const errors: TemplateStructureError[] = [];

  // Distinguishes sibling inline loops so their iteration-scoped numbering
  // keys can never collide (mirrors the block expander's eachExpansionCount).
  let eachExpansionCount = 0;

  for (const [index, paragraph] of body
    .getElementsByTagNameNS(W_NS, "p")
    .entries()) {
    const text = paragraphSpanText(paragraph);
    if (!hasBlockDirectivePattern().test(text)) {
      continue;
    }
    if (blockDirectiveLinePattern().test(text)) {
      // Whole-paragraph directive line — block engine territory (see header).
      continue;
    }

    const parsed = parseInlineConditions(text);
    if (!parsed.ok) {
      errors.push({
        message: parsed.message,
        paragraphIndex: index,
        directive: parsed.directive,
      });
      continue;
    }
    if (parsed.groups.length === 0) {
      continue;
    }

    // Groups never nest and appear in document order, so every group's range is
    // disjoint. Apply them back-to-front (descending start) so each mutation
    // only shifts offsets below it, leaving the not-yet-applied lower groups'
    // offsets valid. `if` groups are plain string cuts; `each` groups splice
    // cloned run sequences (preserving body run formatting) at the run level.
    const ordered = [...parsed.groups].toSorted((a, b) => b.start - a.start);
    for (const group of ordered) {
      if (group.kind === "each") {
        applyInlineEach(paragraph, group, data, eachExpansionCount);
        eachExpansionCount += 1;
        continue;
      }
      const winning = group.branches.find(
        (branch) =>
          branch.condition === "" ||
          evaluateCondition(branch.condition, data, namedConditions),
      );
      const cuts: { start: number; end: number; value: string }[] = [];
      if (winning) {
        cuts.push({ start: group.start, end: winning.contentStart, value: "" });
        cuts.push({ start: winning.contentEnd, end: group.end, value: "" });
      } else {
        cuts.push({ start: group.start, end: group.end, value: "" });
      }
      replaceParagraphTextRanges(paragraph, cuts);
    }
  }

  return errors;
};

/**
 * Expand an inline `{{#each}}` span at the run level, preserving run formatting
 * authored inside the body. Deep-clones the body's run sequence once per array
 * item (via {@link expandInlineEachRuns}) and applies the SAME per-item text
 * substitution the block expander uses to each cloned run's text, keeping its
 * `rPr`. The concatenated per-item clones replace the whole `{{#each}}…{{/each}}`
 * marker span; an empty/non-array array removes the span entirely.
 *
 * Reuses the block loop's item substitution rather than re-deriving it: each
 * iteration rewrites `{{arrayPath.field}}` → the synthetic `__each_*` key
 * (rewriteEachPlaceholdersInText), registers that item's values under the same
 * keys (registerItemPatchValues), then fills them (replacePlaceholdersInText).
 * String/number/object items resolve exactly as in the block expander.
 *
 * Iteration tokens (`{{@index}}` 1-based, `{{@count}}`) and loop-local
 * numbering markers (`{{@num:Key}}`/`{{@ref:Key}}`) are handled per item the
 * same way the block expander handles them: tokens resolve to the iteration's
 * position/count, and each iteration's local `@num`/`@ref` keys get a
 * per-(expansion, index) suffix so the later numbering pass numbers each copy
 * sequentially. `expansionId` distinguishes sibling inline loops.
 *
 * The substitution runs per cloned run's text fragment. Markers and `{{path}}`
 * placeholders authored inside the body must not straddle a run boundary (same
 * constraint the raw-XML numbering and discovery passes carry); the inline-each
 * body is authored as plain runs, so a placeholder lives in one run. Inline
 * conditionals inside the body are not expanded (flat-each only; see the V1
 * nesting rule); a stray `{{path}}` left unresolved stays as literal text.
 */
const applyInlineEach = (
  paragraph: slimdom.Element,
  group: InlineEachGroup,
  data: Record<string, unknown>,
  expansionId: number,
): void => {
  const arrayData = resolvePath(group.arrayPath, data);
  const items: unknown[] = Array.isArray(arrayData) ? arrayData : [];

  // `@num` keys defined in the span are loop-local; scope only those so a
  // `@ref` to a shared clause outside the loop still resolves (block parity).
  const spanText = paragraphSpanText(paragraph).slice(
    group.contentStart,
    group.contentEnd,
  );
  const localNumKeys = collectNumKeysInText(spanText);

  const rewriteItem = (text: string, itemIdx: number): string => {
    const item = items[itemIdx];
    const itemValues: Record<string, RichPatchValue> = {};
    if (isRecord(item)) {
      registerItemPatchValues(itemValues, item, group.arrayPath, itemIdx, "");
    } else if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      // Primitive array: support the raw `{{__each_path_N}}` key (matching the
      // block expander) and `{{path.value}}` so authors have a writable field.
      const value = typeof item === "string" ? item : String(item);
      itemValues[`__each_${group.arrayPath}_${itemIdx}`] = value;
      itemValues[eachKey(group.arrayPath, itemIdx, "value")] = value;
    }

    let iteration = rewriteEachPlaceholdersInText(
      text,
      group.arrayPath,
      itemIdx,
    );
    iteration = rewriteIterationTokensInText(iteration, itemIdx, items.length);
    if (localNumKeys.size > 0) {
      iteration = scopeIterationNumberingInText(iteration, {
        localKeys: localNumKeys,
        expansionId,
        index: itemIdx,
        scope: "ieach",
      });
    }
    return replacePlaceholdersInText(iteration, itemValues).text;
  };

  expandInlineEachRuns(
    paragraph,
    {
      start: group.start,
      end: group.end,
      contentStart: group.contentStart,
      contentEnd: group.contentEnd,
    },
    items.length,
    rewriteItem,
  );
};

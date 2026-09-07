/**
 * Inline conditional spans:
 * `{% if expr %} … {% elif expr %} … {% else %} … {% endif %}` WITHIN one
 * paragraph's text. Block-level processing only recognizes directives that
 * own a whole paragraph; legal drafting also needs conditional phrases:
 * "the Buyer{% if hasSpouse %} and their spouse{% endif %} hereby…".
 *
 * Runs after {@link processBlockDirectives} (whole-paragraph directives and
 * loop expansion are settled, so every surviving paragraph is final) and
 * before serialization — i.e. before numbering, placeholder discovery, and
 * `{{path}}` substitution in the fill pipeline. See the call site in
 * patch-template.ts for the full ordering rationale.
 *
 * Rules (deliberate; violations surface as TemplateStructureError):
 * - Inline ifs and inline loops nest, to {@link MAX_INLINE_NESTING} levels.
 *   `{% for a in attorneys %}{{ a.name }}{% if not loop.last %}, {% endif %}
 *   {% endfor %}` — the comma-join every drafting model writes — is the case
 *   this exists for, and an item-field condition (`{% if a.role == "lead" %}`)
 *   reads the same way. Nesting is resolved by repeating the pass: each pass
 *   applies the OUTERMOST groups, and what they leave behind is top-level for
 *   the next one. A loop's iteration rewrites the references its body makes to
 *   itself — `alias.field` to that iteration's synthetic key, `loop.*` to its
 *   literal — so each expanded copy's condition reads its own item.
 * - Inline `{% for alias in path %} … {% endfor %}` wraps a mid-paragraph span: the array
 *   at `path` is read from the top-level data and the content span is repeated
 *   once per item, with each item's `{{ alias.field }}` references resolved to
 *   that item's values (the same synthetic-key rewrite the block loop uses,
 *   shared via rewriteEachPlaceholdersInText/registerItemPatchValues). The
 *   span's run sequence is deep-cloned per item, so run-level formatting
 *   authored inside the body (bold/italic/etc.) is preserved in every expanded
 *   copy. Author separators written inside the span (", " etc.) are part of the
 *   runs and repeat with it; an empty array removes the whole
 *   `{% for %}…{% endfor %}` span.
 * - An inline if/loop must open and close within the same paragraph: an opener
 *   without a closer, or a closer/`{% elif %}`/`{% else %}` without an
 *   opener, is a structure error naming the paragraph (index + excerpt).
 * - `{% elif %}` and `{% else %}` follow block semantics: the first branch
 *   whose condition holds wins; `{% else %}` always wins when reached.
 * - A paragraph with a structure error is left untouched (its markers stay
 *   in the output) and only the first error per paragraph is reported.
 * - Conditions and array paths evaluate against the top-level template data
 *   plus the manifest's named conditions. Paragraphs cloned by a block loop
 *   retain that iteration's inherited row context, matching nested block
 *   condition semantics.
 * - The caller runs this pass for the body and every header/footer content
 *   part, matching discovery and scalar value replacement coverage.
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
  LOOP_PROPERTIES,
  type FilterCall,
  type LoopProperty,
  type NamedCondition,
  resolvePath,
  scanMarkers,
} from "@stll/template-conditions";

import {
  collectNumKeysInText,
  createDirectiveProcessingContext,
  type DirectiveProcessingContext,
  eachKey,
  escapeRegExp,
  registerLoopItemPatchValues,
  rewriteEachPlaceholdersInText,
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

/** A mid-paragraph `{% for alias in path %} … {% endfor %}` span. */
type InlineEachGroup = {
  kind: "for";
  alias: string;
  arrayPath: string;
  /** Filters on the loop path, which configure the array. */
  filters: readonly FilterCall[];
  /** Offset of the opener's `{{`. */
  start: number;
  /** Offset just past the closer's `}}`. */
  end: number;
  /** Offset just past the opener's `}}` — start of the repeated span. */
  contentStart: number;
  /** Offset of the closer's `{{` — end of the repeated span. */
  contentEnd: number;
};

export type InlineGroup = InlineIfGroup | InlineEachGroup;

type InlineParse =
  | { ok: true; groups: InlineGroup[] }
  | { ok: false; message: string; directive: string };

/** Narrow `unknown` to a non-array string-keyed record. */
const EXCERPT_LENGTH = 60;

/** Short paragraph excerpt so a structure error names the paragraph. */
const excerpt = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, EXCERPT_LENGTH)}…`;
};

/**
 * How deep inline blocks may nest in one paragraph. A drafting sentence needs
 * two ("repeat this, and put a comma between all but the last"); the bound is
 * what keeps a pathological paragraph from costing an unbounded number of
 * passes.
 */
export const MAX_INLINE_NESTING = 4;

/** One open block while the parser walks a paragraph. */
type OpenIfFrame = {
  kind: "if";
  raw: string;
  start: number;
  branches: InlineBranch[];
  condition: string;
  contentStart: number;
};

type OpenForFrame = {
  kind: "for";
  raw: string;
  start: number;
  alias: string;
  arrayPath: string;
  filters: readonly FilterCall[];
  contentStart: number;
};

type OpenFrame = OpenIfFrame | OpenForFrame;

/**
 * Parse one paragraph's span text into its OUTERMOST inline groups. Nested
 * groups are validated (balanced, closed by their own closer, within the depth
 * bound) but not returned: applying an outer group leaves its inner markers in
 * the paragraph, where the next pass reads them as top-level.
 *
 * Returns the first violation, since offsets after it are ambiguous and the
 * caller leaves the whole paragraph untouched.
 */
export const parseInlineConditions = (text: string): InlineParse => {
  const groups: InlineGroup[] = [];
  const open: OpenFrame[] = [];

  const fail = (message: string, directive: string): InlineParse => ({
    ok: false,
    message: `${message} in paragraph "${excerpt(text)}"`,
    directive,
  });

  /** An outermost group is the one the caller applies; an inner one is left
   *  in the text for the next pass. */
  const close = (group: InlineGroup): void => {
    if (open.length === 0) {
      groups.push(group);
    }
  };

  for (const marker of scanMarkers(text)) {
    const { meta } = marker;
    switch (meta.kind) {
      case "placeholder":
      case "clause":
      case "num":
      case "ref":
      case "loop":
        break;
      case "if":
      case "for": {
        if (open.length >= MAX_INLINE_NESTING) {
          return fail(
            `Inline blocks nest at most ${MAX_INLINE_NESTING} deep`,
            marker.raw,
          );
        }
        open.push(
          meta.kind === "if"
            ? {
                kind: "if",
                raw: marker.raw,
                start: marker.start,
                branches: [],
                condition: meta.expr,
                contentStart: marker.end,
              }
            : {
                kind: "for",
                raw: marker.raw,
                start: marker.start,
                alias: meta.alias,
                arrayPath: meta.path,
                filters: meta.filters,
                contentStart: marker.end,
              },
        );
        break;
      }
      case "elif":
      case "else": {
        const frame = open.at(-1);
        if (frame?.kind !== "if") {
          return fail(
            `Orphaned inline ${marker.raw} without an open {% if %}`,
            marker.raw,
          );
        }
        frame.branches.push({
          condition: frame.condition,
          contentStart: frame.contentStart,
          contentEnd: marker.start,
        });
        frame.condition = meta.kind === "elif" ? meta.expr : "";
        frame.contentStart = marker.end;
        break;
      }
      case "endif": {
        const frame = open.at(-1);
        if (frame?.kind !== "if") {
          return fail(
            "Orphaned inline {% endif %} without an open {% if %}",
            marker.raw,
          );
        }
        open.pop();
        frame.branches.push({
          condition: frame.condition,
          contentStart: frame.contentStart,
          contentEnd: marker.start,
        });
        close({
          kind: "if",
          start: frame.start,
          end: marker.end,
          branches: frame.branches,
        });
        break;
      }
      case "endfor": {
        const frame = open.at(-1);
        if (frame?.kind !== "for") {
          return fail(
            "Orphaned inline {% endfor %} without an open {% for %}",
            marker.raw,
          );
        }
        open.pop();
        close({
          kind: "for",
          alias: frame.alias,
          arrayPath: frame.arrayPath,
          filters: frame.filters,
          start: frame.start,
          end: marker.end,
          contentStart: frame.contentStart,
          contentEnd: marker.start,
        });
        break;
      }
      default:
        assertNever(meta);
    }
  }

  const unclosed = open.at(-1);
  if (unclosed) {
    return fail(
      unclosed.kind === "if"
        ? "Unclosed inline {% if %} — the {% endif %} must be in the same paragraph"
        : "Unclosed inline {% for %} — the {% endfor %} must be in the same paragraph",
      unclosed.raw,
    );
  }

  return { ok: true, groups };
};

/**
 * Resolve inline conditional spans in every paragraph of `body` (including
 * table cells). Mutates the DOM: the winning `{% if %}` branch's content stays
 * with its original runs/formatting, the markers and losing branches are cut
 * across split runs; a `{% for %}` span's body run sequence is deep-cloned per
 * item (preserving run formatting) and spliced in over the marker span. Returns
 * structural errors; erroring paragraphs are left untouched.
 */
export const processInlineConditions = (
  body: slimdom.Element,
  data: Record<string, unknown>,
  namedConditions?: NamedCondition[],
  options: { processingContext?: DirectiveProcessingContext } = {},
): TemplateStructureError[] => {
  const errors: TemplateStructureError[] = [];
  const processingContext =
    options.processingContext ?? createDirectiveProcessingContext();

  for (const [index, paragraph] of body
    .getElementsByTagNameNS(W_NS, "p")
    .entries()) {
    // One pass per nesting level: a pass applies the outermost groups, and
    // what they leave behind is top-level for the next one. The bound is the
    // parser's own, plus the pass that finds nothing left to do.
    const paragraphData: Record<string, unknown> = {
      ...(processingContext.inlineDataByParagraph.get(paragraph) ?? data),
    };
    for (let pass = 0; pass <= MAX_INLINE_NESTING; pass += 1) {
      const text = paragraphSpanText(paragraph);
      if (!hasBlockDirectivePattern().test(text)) {
        break;
      }
      if (blockDirectiveLinePattern().test(text)) {
        // Whole-paragraph directive line — block engine territory (see header).
        break;
      }

      const parsed = parseInlineConditions(text);
      if (!parsed.ok) {
        errors.push({
          message: parsed.message,
          paragraphIndex: index,
          directive: parsed.directive,
        });
        break;
      }
      if (parsed.groups.length === 0) {
        break;
      }

      // Outermost groups appear in document order and their ranges are
      // disjoint. Apply them back-to-front (descending start) so each mutation
      // only shifts offsets below it, leaving the not-yet-applied lower groups'
      // offsets valid. `if` groups are plain string cuts; `for` groups splice
      // cloned run sequences (preserving body run formatting) at the run level.
      for (const group of parsed.groups.toSorted((a, b) => b.start - a.start)) {
        if (group.kind === "for") {
          applyInlineEach({
            data: paragraphData,
            expansionId: processingContext.nextEachExpansionId(),
            group,
            paragraph,
          });
          continue;
        }
        const winning = group.branches.find(
          (branch) =>
            branch.condition === "" ||
            evaluateCondition(branch.condition, paragraphData, namedConditions),
        );
        const cuts: { start: number; end: number; value: string }[] = [];
        if (winning) {
          cuts.push({
            start: group.start,
            end: winning.contentStart,
            value: "",
          });
          cuts.push({ start: winning.contentEnd, end: group.end, value: "" });
        } else {
          cuts.push({ start: group.start, end: group.end, value: "" });
        }
        replaceParagraphTextRanges(paragraph, cuts);
      }
    }
  }

  return errors;
};

/**
 * Expand an inline `{% for %}` span at the run level, preserving run formatting
 * authored inside the body. Deep-clones the body's run sequence once per array
 * item (via {@link expandInlineEachRuns}) and applies the SAME per-item text
 * substitution the block expander uses to each cloned run's text, keeping its
 * `rPr`. The concatenated per-item clones replace the whole `{% for %}…{% endfor %}`
 * marker span; an empty/non-array array removes the span entirely.
 *
 * Reuses the block loop's item substitution rather than re-deriving it: each
 * iteration rewrites `{{ alias.field }}` → the synthetic `__each_*` key
 * (rewriteEachPlaceholdersInText), registers that item's values under the same
 * keys (registerItemPatchValues), then fills them (replacePlaceholdersInText).
 * String/number/object items resolve exactly as in the block expander.
 *
 * Iteration tokens (`{{ loop.index }}` 1-based, `{{ loop.length }}`) and loop-local
 * numbering markers (`{{ num("Key") }}`/`{{ ref("Key") }}`) are handled per item the
 * same way the block expander handles them: tokens resolve to the iteration's
 * position/count, and each iteration's local `num()`/`ref()` keys get a
 * per-(expansion, index) suffix so the later numbering pass numbers each copy
 * sequentially. `expansionId` distinguishes sibling inline loops.
 *
 * A nested `{% if %}` (or a nested `{% for %}`) inside the body is NOT
 * resolved here: it is left in each expanded copy with its references rewritten
 * to that copy's own iteration — `alias.field` to the iteration's synthetic
 * key, `loop.*` to its literal — and those synthetic values are published into
 * the paragraph's evaluation context. The next pass then reads each copy's
 * condition as a top-level inline block that sees its own item.
 *
 * The substitution runs per cloned run's text fragment. Markers and `{{path}}`
 * placeholders authored inside the body must not straddle a run boundary (same
 * constraint the raw-XML numbering and discovery passes carry); the inline-loop
 * body is authored as plain runs, so a placeholder lives in one run. A stray
 * `{{path}}` left unresolved stays as literal text.
 */
type ApplyInlineEachOptions = {
  data: Record<string, unknown>;
  expansionId: number;
  group: InlineEachGroup;
  paragraph: slimdom.Element;
};

const applyInlineEach = ({
  data,
  expansionId,
  group,
  paragraph,
}: ApplyInlineEachOptions): void => {
  const arrayData = resolvePath(group.arrayPath, data);
  const items: unknown[] = Array.isArray(arrayData) ? arrayData : [];

  // `num()` keys defined in the span are loop-local; scope only those so a
  // `ref()` to a shared clause outside the loop still resolves (block parity).
  const spanText = paragraphSpanText(paragraph).slice(
    group.contentStart,
    group.contentEnd,
  );
  const localNumKeys = collectNumKeysInText(spanText);

  // A nested block inside the body reads the iteration through the same
  // synthetic keys its placeholders were rewritten to, so publish them where
  // `evaluateCondition` and the next pass's `{% for %}` will look.
  for (const [itemIdx, item] of items.entries()) {
    registerIterationContext(data, item, group.arrayPath, itemIdx);
  }

  // `loop` names the INNERMOST loop, so a reference inside a nested
  // `{% for %}` belongs to that loop and is left for its own expansion. Depth
  // is carried across the text fragments of one item's clone, which arrive in
  // document order and restart at fragment 0.
  let depth = 0;
  const rewriteItem = (
    text: string,
    itemIdx: number,
    fragmentIndex: number,
  ): string => {
    if (fragmentIndex === 0) {
      depth = 0;
    }
    const item = items[itemIdx];
    const itemValues: Record<string, RichPatchValue> = {};
    registerLoopItemPatchValues(itemValues, item, group.arrayPath, itemIdx);

    let iteration = rewriteEachPlaceholdersInText(
      text,
      group.arrayPath,
      itemIdx,
      group.alias,
    );
    const references = rewriteIterationReferences(iteration, {
      alias: group.alias,
      arrayPath: group.arrayPath,
      count: items.length,
      depth,
      index: itemIdx,
    });
    iteration = references.text;
    depth = references.depth;
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

// ── One iteration's view of itself ───────────────────────

const LOOP_REFERENCE_RE =
  /\bloop\.(?<property>index0|index|first|last|length)\b/gu;

type IterationReferenceOptions = {
  alias: string;
  arrayPath: string;
  count: number;
  /** Loops open at the start of this fragment; `loop` binds to the innermost,
   *  so only depth 0 belongs to the loop being expanded. */
  depth: number;
  index: number;
};

type IterationReferenceResult = { text: string; depth: number };

/**
 * Rewrite the references one iteration's body makes to the loop it belongs to.
 *
 * `loop.*` becomes that iteration's literal — in an output marker and inside a
 * tag alike — but only at depth 0, since `loop` names the innermost loop and a
 * nested one resolves its own on the pass that expands it. An `alias.field`
 * reference inside a tag becomes the iteration's synthetic key at every depth:
 * an inner loop binds a different name, so the outer alias is unambiguous
 * wherever it appears (shadowing a loop's alias is not supported).
 *
 * Returns the depth at the end of the fragment, so the caller can carry it
 * into the next one.
 */
const rewriteIterationReferences = (
  text: string,
  { alias, arrayPath, count, depth, index }: IterationReferenceOptions,
): IterationReferenceResult => {
  const heads = [...new Set([alias, arrayPath])].map(escapeRegExp).join("|");
  const itemReference = new RegExp(
    `(?<![\\p{L}\\p{N}_.-])(?:${heads})\\.(?<field>[.\\p{L}\\p{N}_-]+)`,
    "gu",
  );
  const toLiteral = (fragment: string): string =>
    fragment.replace(LOOP_REFERENCE_RE, (match, property: string) =>
      isLoopProperty(property)
        ? String(loopLiteral(property, index, count))
        : match,
    );
  const toSyntheticKey = (fragment: string): string =>
    fragment.replace(itemReference, (_match, field: string) =>
      eachKey(arrayPath, index, field),
    );

  let out = "";
  let cursor = 0;
  let current = depth;
  for (const marker of scanMarkers(text)) {
    out += text.slice(cursor, marker.start);
    cursor = marker.end;
    const { meta, raw } = marker;
    switch (meta.kind) {
      case "endfor":
        current -= 1;
        out += raw;
        break;
      case "loop":
        // A printed counter becomes the value itself: nothing later resolves
        // a marker, so the whole span is replaced.
        out +=
          current === 0
            ? String(loopLiteral(meta.property, index, count))
            : raw;
        break;
      case "placeholder":
      case "clause":
      case "num":
      case "ref":
        out += raw;
        break;
      case "for":
        out += toSyntheticKey(current === 0 ? toLiteral(raw) : raw);
        current += 1;
        break;
      case "if":
      case "elif":
      case "else":
      case "endif":
        out += toSyntheticKey(current === 0 ? toLiteral(raw) : raw);
        break;
      default:
        assertNever(meta);
    }
  }
  return { text: out + text.slice(cursor), depth: current };
};

const isLoopProperty = (value: string): value is LoopProperty =>
  LOOP_PROPERTIES.some((property) => property === value);

const loopLiteral = (
  property: LoopProperty,
  index: number,
  count: number,
): number | boolean => {
  switch (property) {
    case "index":
      return index + 1;
    case "index0":
      return index;
    case "first":
      return index === 0;
    case "last":
      return index === count - 1;
    case "length":
      return count;
    default:
      return assertNever(property);
  }
};

/**
 * Publish one iteration's values under the synthetic keys its rewritten body
 * reads. Scalars answer a nested condition; arrays answer a nested
 * `{% for %}`, whose path was rewritten the same way.
 */
const registerIterationContext = (
  context: Record<string, unknown>,
  item: unknown,
  arrayPath: string,
  index: number,
): void => {
  const visit = (value: unknown, field: string): void => {
    context[eachKey(arrayPath, index, field)] = value;
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, `${field}.${key}`);
    }
  };
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    context[eachKey(arrayPath, index, "value")] = item;
    return;
  }
  for (const [key, value] of Object.entries(item)) {
    visit(value, key);
  }
};

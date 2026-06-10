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
 * - Inline ifs do not nest: a second `{{#if}}` while an inline span is open
 *   in the same paragraph is a structure error.
 * - Inline `{{#each}}` is not supported: a mid-paragraph `{{#each}}` or
 *   `{{/each}}` is a structure error.
 * - An inline if must open and close within the same paragraph: an opener
 *   without a closer, or a closer/`{{#elseif}}`/`{{#else}}` without an
 *   opener, is a structure error naming the paragraph (index + excerpt).
 * - `{{#elseif}}` and `{{#else}}` follow block semantics: the first branch
 *   whose condition holds wins; `{{#else}}` always wins when reached.
 * - A paragraph with a structure error is left untouched (its markers stay
 *   in the output) and only the first error per paragraph is reported.
 * - Conditions evaluate against the top-level template data plus the
 *   manifest's named conditions — the same context as a top-level block
 *   `{{#if}}`. Inline ifs inside an `{{#each}}` body do NOT see the
 *   iteration item: loop expansion has already run when this pass executes.
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
  scanMarkers,
} from "@stll/template-conditions";

import { W_NS } from "./ooxml";
import { paragraphSpanText, replaceParagraphTextRanges } from "./rich-patch";
import type { TemplateStructureError } from "./types";

/** Mirrors the block engine's IfBranch: `condition === ""` is the
 *  always-true else branch. Offsets index the paragraph's span text. */
type InlineBranch = {
  condition: string;
  contentStart: number;
  contentEnd: number;
};

type InlineIfGroup = {
  /** Offset of the opener's `{{`. */
  start: number;
  /** Offset just past the closer's `}}`. */
  end: number;
  branches: InlineBranch[];
};

type InlineParse =
  | { ok: true; groups: InlineIfGroup[] }
  | { ok: false; message: string; directive: string };

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
  const groups: InlineIfGroup[] = [];
  let open: {
    raw: string;
    start: number;
    branches: InlineBranch[];
    condition: string;
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
        break;
      case "each":
      case "endeach":
        return fail("Inline {{#each}} is not supported", marker.raw);
      case "if":
        if (open) {
          return fail("Nested inline {{#if}} is not supported", marker.raw);
        }
        open = {
          raw: marker.raw,
          start: marker.start,
          branches: [],
          condition: meta.expr,
          contentStart: marker.end,
        };
        break;
      case "elseif":
      case "else":
        if (!open) {
          return fail(
            `Orphaned inline ${marker.raw} without an open {{#if}}`,
            marker.raw,
          );
        }
        open.branches.push({
          condition: open.condition,
          contentStart: open.contentStart,
          contentEnd: marker.start,
        });
        open.condition = meta.kind === "elseif" ? meta.expr : "";
        open.contentStart = marker.end;
        break;
      case "endif":
        if (!open) {
          return fail(
            "Orphaned inline {{/if}} without an open {{#if}}",
            marker.raw,
          );
        }
        open.branches.push({
          condition: open.condition,
          contentStart: open.contentStart,
          contentEnd: marker.start,
        });
        groups.push({
          start: open.start,
          end: marker.end,
          branches: open.branches,
        });
        open = null;
        break;
      default:
        assertNever(meta);
    }
  }

  if (open) {
    return fail(
      "Unclosed inline {{#if}} — the {{/if}} must be in the same paragraph",
      open.raw,
    );
  }

  return { ok: true, groups };
};

/**
 * Resolve inline conditional spans in every paragraph of `body` (including
 * table cells). Mutates the DOM: the winning branch's content stays with
 * its original runs/formatting, the markers and losing branches are cut
 * across split runs. Returns structural errors; erroring paragraphs are
 * left untouched.
 */
export const processInlineConditions = (
  body: slimdom.Element,
  data: Record<string, unknown>,
  namedConditions?: NamedCondition[],
): TemplateStructureError[] => {
  const errors: TemplateStructureError[] = [];

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

    // Groups never nest and appear in document order, so all cut ranges are
    // disjoint; replaceParagraphTextRanges applies them back-to-front.
    const cuts: { start: number; end: number; value: string }[] = [];
    for (const group of parsed.groups) {
      const winning = group.branches.find(
        (branch) =>
          branch.condition === "" ||
          evaluateCondition(branch.condition, data, namedConditions),
      );
      if (!winning) {
        cuts.push({ start: group.start, end: group.end, value: "" });
        continue;
      }
      cuts.push({ start: group.start, end: winning.contentStart, value: "" });
      cuts.push({ start: winning.contentEnd, end: group.end, value: "" });
    }
    replaceParagraphTextRanges(paragraph, cuts);
  }

  return errors;
};

/**
 * DOCX block-directive pre-processor.
 *
 * Scans OOXML body paragraphs for block directives
 * ({{#if}}, {{#each}}, etc.), evaluates conditions, expands
 * loops, and strips directive paragraphs — all before
 * value substitution.
 *
 * Templates without block directives skip all processing
 * (fast-path check via regex on raw XML).
 *
 * `{{#each}}` loop bodies clone block-level units, not just
 * paragraphs. Placement decides what a loop repeats:
 *   - ROW REPEAT: when the opener `{{#each}}` and its matching
 *     `{{/each}}` are paragraphs confined to the SAME table row
 *     (`w:tr`), the whole row is cloned once per item and the two
 *     marker paragraphs are stripped from the output rows (a cell
 *     left with no paragraph is backfilled with an empty one so
 *     the row stays valid OOXML). Zero items removes the row.
 *   - BLOCK REPEAT: when the opener and closer are block-level
 *     siblings (typically direct children of `w:body`), every
 *     block child between them — paragraphs AND whole tables
 *     (`w:tbl`) — is cloned as a unit per item.
 * A marker pair that straddles a table boundary (opener in a row,
 * closer outside it, or the two in different rows) is ambiguous:
 * it is reported as a {@link TemplateStructureError} and its
 * markers are neutralized rather than producing corrupt XML.
 *
 * Nested loops resolve through per-item recursion: an inner
 * `{{#each outer.sub}}` keeps its path and is expanded against the
 * outer item's context (so `outer.sub` resolves to that item's
 * array), while the outer pass defers rewriting placeholders that
 * belong to the inner loop (`{{outer.sub.field}}`). This is what
 * lets a body-level `{{#each contracts}}` wrap a table whose single
 * template row repeats over `{{#each contracts.fields}}`.
 *
 * Word list numbering (`w:numPr`) survives loop expansion
 * untouched: every cloned paragraph keeps its original
 * `w:numId`, so Word numbers all iterations as one continuous
 * sequence (counters live on the abstract definition, not the
 * paragraph) — the legal-document expectation. Restarting per
 * iteration would require cloning `w:num`/`w:abstractNum`
 * entries and would still leak shared counters through
 * `w:numStyleLink`, so it is deliberately not offered. The only
 * numbering.xml knowledge needed here is reference validity:
 * see {@link collectValidNumIds} / {@link pruneDanglingNumPr}.
 */

import * as slimdom from "slimdom";

import {
  blockDirectiveLinePattern,
  countPattern,
  evaluateCondition,
  hasBlockDirectivePattern,
  indexPattern,
  numPattern,
  refPattern,
  resolvePath,
} from "@stll/template-conditions";
import type { NamedCondition } from "@stll/template-conditions";

import { ancestorByLocalName, isElement, paragraphText, W_NS } from "./ooxml";
import type {
  Block,
  BlockDirective,
  BlockDirectiveKind,
  EachBlock,
  IfBlock,
  IfBranch,
  RichPatchValue,
  TemplateData,
  TemplateStructureError,
} from "./types";

export { evaluateCondition, resolvePath };

/**
 * Symbol key under which the fill pipeline stashes the *raw* (pre-format)
 * values of fields that a later step rewrites to a display string, so that
 * `{{#if}}` conditions evaluate against the original value. Today this carries
 * date fields: a `date` input is submitted as an ISO `YYYY-MM-DD` string, then
 * `applyDateFields` rewrites it in place to localized display text (e.g.
 * "13. června 2028") for substitution. The condition engine's ordering
 * comparisons (`>`, `<`, …) only work on the ISO shape, so a field that is both
 * formatted *and* referenced by a condition must be compared raw. The overlay
 * is keyed by field path and read by {@link processBlockDirectives} when
 * building the condition-evaluation context.
 *
 * A Symbol key (not a string) is deliberate: the same shared values map is
 * iterated as field paths everywhere else (substitution, `flattenTemplateData`,
 * unmatched/unused diagnostics, `isTemplateData`), all of which use
 * `Object.keys`/`values`/`entries` and so skip symbol keys. The overlay
 * therefore travels on the map without ever colliding with a user field path or
 * leaking into substitution. It survives object spread (`{ ...values }`), so it
 * reaches `fillTemplate` across the boundaries that copy the map.
 */
export const CONDITION_RAW_VALUES = Symbol("condition-raw-values");

/** Read the raw-value condition overlay stashed under {@link CONDITION_RAW_VALUES}. */
export const readConditionRawValues = (
  values: object,
): Record<string, string> | undefined => {
  const overlay: unknown = Reflect.get(values, CONDITION_RAW_VALUES);
  return isStringRecord(overlay) ? overlay : undefined;
};

/** Narrow `unknown` to a `Record<string, string>` (the overlay shape). */
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === "object" &&
  v !== null &&
  Object.values(v).every((entry) => typeof entry === "string");

/**
 * Overlay one loop row's raw (pre-format) values onto its iteration context, so
 * an inner-loop `{{#if dob > "2028-01-01"}}` compares the original ISO date
 * rather than the localized display text the date step wrote into the row for
 * substitution. Raw values are stashed by field path under
 * `<arrayPath>.<index>.<subPath>` (see {@link CONDITION_RAW_VALUES}); each match
 * sets the bare item-relative sub-path, which the loop body's condition resolves
 * the same way it resolves the row's other fields.
 */
const applyRowRawOverlay = (
  itemContext: Record<string, unknown>,
  rawValues: Record<string, string> | undefined,
  arrayPath: string,
  index: number,
): void => {
  if (!rawValues) {
    return;
  }
  const prefix = `${arrayPath}.${index}.`;
  for (const [key, raw] of Object.entries(rawValues)) {
    if (key.startsWith(prefix)) {
      itemContext[key.slice(prefix.length)] = raw;
    }
  }
};

// ── Regex patterns ───────────────────────────────────────

// Canonical patterns from @stll/template-conditions (markers.ts).
/** Matches a block directive as the sole paragraph content. */
const DIRECTIVE_RE = blockDirectiveLinePattern();

/** Fast-path: does the raw XML contain any block directives? */
export const HAS_BLOCK_DIRECTIVES_RE = hasBlockDirectivePattern();

// ── Type guards ─────────────────────────────────────────

/** Narrow `unknown` to a string-keyed record. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Check if a value is a RichPatchValue (string or rich text). */
const isRichPatchValue = (v: unknown): v is RichPatchValue =>
  typeof v === "string" ||
  (typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "paragraphs" in v);

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

// ── Directive scanning ───────────────────────────────────

const KIND_MAP: Record<string, BlockDirectiveKind> = {
  "#if": "if",
  "#elseif": "elseif",
  "#else": "else",
  "#each": "each",
  "/if": "endif",
  "/each": "endeach",
};

/**
 * Extract block directives from body paragraphs.
 * Returns directives in document order.
 */
export const scanBlockDirectives = (
  body: slimdom.Element,
): BlockDirective[] => {
  const directives: BlockDirective[] = [];
  const paragraphs = body.getElementsByTagNameNS(W_NS, "p");

  for (const [i, p] of paragraphs.entries()) {
    const text = paragraphText(p);
    const match = DIRECTIVE_RE.exec(text);
    if (!match) {
      continue;
    }

    const tag = match.groups?.["tag"];
    const rawExpr = match.groups?.["expr"];
    if (!tag || rawExpr === undefined) {
      continue;
    }
    const expr = rawExpr.trim();

    const kind = KIND_MAP[tag];
    if (kind) {
      directives.push({
        kind,
        expression: expr,
        paragraphIndex: i,
      });
    }
  }

  return directives;
};

// ── Block tree parsing ───────────────────────────────────

type ParseResult = {
  blocks: Block[];
  errors: TemplateStructureError[];
};

/**
 * Parse a flat list of directives into a nested block tree.
 * Validates matching open/close pairs and reports errors.
 */
export const parseBlockTree = (
  directives: readonly BlockDirective[],
): ParseResult => {
  const blocks: Block[] = [];
  const errors: TemplateStructureError[] = [];

  let i = 0;

  const parseBlocks = (): Block[] => {
    const result: Block[] = [];

    while (i < directives.length) {
      const d = directives[i];
      if (!d) {
        break;
      }

      if (d.kind === "if") {
        const ifBlock = parseIfBlock();
        if (ifBlock) {
          result.push(ifBlock);
        }
      } else if (d.kind === "each") {
        const eachBlock = parseEachBlock();
        if (eachBlock) {
          result.push(eachBlock);
        }
      } else {
        // These are handled by their parent parsers
        break;
      }
    }

    return result;
  };

  const parseIfBlock = (): IfBlock | null => {
    const opening = directives[i];
    if (!opening) {
      return null;
    }
    const directiveParagraphs = [opening.paragraphIndex];
    const branches: IfBranch[] = [];

    i++; // skip #if

    // First branch starts after #if
    let branchCondition = opening.expression;
    let branchStart = opening.paragraphIndex + 1;

    while (i < directives.length) {
      const d = directives[i];
      if (!d) {
        break;
      }

      if (d.kind === "if" || d.kind === "each") {
        // Nested block — skip over it by recursively parsing
        const nested = d.kind === "if" ? parseIfBlock() : parseEachBlock();
        if (!nested) {
          break;
        }
        continue;
      }

      if (d.kind === "elseif") {
        branches.push({
          condition: branchCondition,
          contentStart: branchStart,
          contentEnd: d.paragraphIndex,
        });
        directiveParagraphs.push(d.paragraphIndex);
        branchCondition = d.expression;
        branchStart = d.paragraphIndex + 1;
        i++;
        continue;
      }

      if (d.kind === "else") {
        branches.push({
          condition: branchCondition,
          contentStart: branchStart,
          contentEnd: d.paragraphIndex,
        });
        directiveParagraphs.push(d.paragraphIndex);
        branchCondition = ""; // empty = always true (else)
        branchStart = d.paragraphIndex + 1;
        i++;
        continue;
      }

      if (d.kind === "endif") {
        branches.push({
          condition: branchCondition,
          contentStart: branchStart,
          contentEnd: d.paragraphIndex,
        });
        directiveParagraphs.push(d.paragraphIndex);
        i++;
        return { kind: "if", branches, directiveParagraphs };
      }

      errors.push({
        message: "Unexpected {{/each}} inside {{#if}} block",
        paragraphIndex: d.paragraphIndex,
        directive: "{{/each}}",
      });
      i++;
      break;
    }

    // Unclosed #if
    errors.push({
      message: "Unclosed {{#if}} block",
      paragraphIndex: opening.paragraphIndex,
      directive: `{{#if ${opening.expression}}}`,
    });
    return null;
  };

  const parseEachBlock = (): EachBlock | null => {
    const opening = directives[i];
    if (!opening) {
      return null;
    }
    const directiveParagraphs = [opening.paragraphIndex];

    i++; // skip #each

    const contentStart = opening.paragraphIndex + 1;

    while (i < directives.length) {
      const d = directives[i];
      if (!d) {
        break;
      }

      if (d.kind === "if" || d.kind === "each") {
        // Nested block — skip over it
        const nested = d.kind === "if" ? parseIfBlock() : parseEachBlock();
        if (!nested) {
          break;
        }
        continue;
      }

      if (d.kind === "endeach") {
        directiveParagraphs.push(d.paragraphIndex);
        i++;
        return {
          kind: "each",
          arrayPath: opening.expression,
          contentStart,
          contentEnd: d.paragraphIndex,
          directiveParagraphs,
        };
      }

      if (d.kind === "endif") {
        errors.push({
          message: "Unexpected {{/if}} inside {{#each}} block",
          paragraphIndex: d.paragraphIndex,
          directive: "{{/if}}",
        });
        i++;
        break;
      }

      errors.push({
        message: `Unexpected {{#${d.kind}}} inside {{#each}} block`,
        paragraphIndex: d.paragraphIndex,
        directive: `{{#${d.kind}}}`,
      });
      i++;
      continue;
    }

    // Unclosed #each
    errors.push({
      message: "Unclosed {{#each}} block",
      paragraphIndex: opening.paragraphIndex,
      directive: `{{#each ${opening.expression}}}`,
    });
    return null;
  };

  blocks.push(...parseBlocks());

  // Check for orphaned closing directives
  while (i < directives.length) {
    const d = directives[i];
    if (!d) {
      i++;
      continue;
    }
    if (
      d.kind === "endif" ||
      d.kind === "endeach" ||
      d.kind === "elseif" ||
      d.kind === "else"
    ) {
      let tag = `{{#${d.kind}}}`;
      if (d.kind === "endif") {
        tag = "{{/if}}";
      } else if (d.kind === "endeach") {
        tag = "{{/each}}";
      }
      errors.push({
        message: `Orphaned ${tag} without matching opening directive`,
        paragraphIndex: d.paragraphIndex,
        directive: tag,
      });
    }
    i++;
  }

  return { blocks, errors };
};

// ── Data flattening ──────────────────────────────────────

/**
 * Recursively flatten nested objects into dot-separated keys.
 * `{ company: { name: "Foo" } }` → `{ "company.name": "Foo" }`
 *
 * Arrays and RichPatchValues are not flattened further.
 */
export const flattenTemplateData = (
  data: TemplateData,
  prefix = "",
): Record<string, RichPatchValue> => {
  const result: Record<string, RichPatchValue> = {};

  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (isRichPatchValue(value)) {
      result[fullKey] = value;
    } else if (typeof value === "number") {
      result[fullKey] = String(value);
    } else if (typeof value === "boolean") {
      result[fullKey] = String(value);
    } else if (Array.isArray(value)) {
      // Arrays are not flattened — handled by #each
    } else if (typeof value === "object") {
      Object.assign(result, flattenTemplateData(value, fullKey));
    }
  }

  return result;
};

// ── w:t node rewriting ───────────────────────────────────

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// ── OOXML block-level tag names ──────────────────────────

/** WordprocessingML local names the loop engine treats as block units. */
const TAG = {
  paragraph: "p",
  table: "tbl",
  row: "tr",
  cell: "tc",
} as const;

// ── Deep clone for slimdom nodes ─────────────────────────

const cloneElement = (
  el: slimdom.Element,
  doc: slimdom.Document,
): slimdom.Element => doc.importNode(el, true);

/**
 * Paragraphs contained in a block-level unit, in document order. A unit that
 * *is* a `w:p` yields itself (`getElementsByTagNameNS` returns descendants
 * only); a `w:tbl` (or any container) yields its descendant paragraphs.
 */
const paragraphsInUnit = (unit: slimdom.Element): slimdom.Element[] =>
  unit.localName === TAG.paragraph && unit.namespaceURI === W_NS
    ? [unit]
    : [...unit.getElementsByTagNameNS(W_NS, TAG.paragraph)];

/** Paragraphs contained in a sequence of block units, in document order. */
const paragraphsInUnits = (
  units: readonly slimdom.Element[],
): slimdom.Element[] => units.flatMap(paragraphsInUnit);

/**
 * Remove a stripped `{{#each}}`/`{{/each}}` marker paragraph from a cloned row,
 * backfilling an empty paragraph when its cell would otherwise be left without
 * one (a `w:tc` must contain at least one block-level child).
 */
const stripRowMarkerParagraph = (
  paragraph: slimdom.Element,
  doc: slimdom.Document,
): void => {
  const cell = ancestorByLocalName(paragraph, TAG.cell);
  paragraph.parentNode?.removeChild(paragraph);
  if (cell && cell.getElementsByTagNameNS(W_NS, TAG.paragraph).length === 0) {
    cell.append(doc.createElementNS(W_NS, "w:p"));
  }
};

// ── Main processor ───────────────────────────────────────

type ProcessResult = {
  patchValues: Record<string, RichPatchValue>;
  errors: TemplateStructureError[];
};

/**
 * Process block directives in a DOCX body element.
 *
 * Mutates the DOM: removes false conditional branches,
 * expands loops, and strips directive paragraphs.
 *
 * Returns flattened patch values for loop-expanded
 * placeholders and any structural errors.
 */
export const processBlockDirectives = (
  body: slimdom.Element,
  data: TemplateData,
  namedConditions?: NamedCondition[],
  conditionValues?: Record<string, string>,
): ProcessResult => {
  const patchValues: Record<string, RichPatchValue> = {};
  const allErrors: TemplateStructureError[] = [];

  // Distinguishes sibling loops (possibly over the same array) so
  // their iteration-scoped numbering keys can never collide.
  let eachExpansionCount = 0;

  // Flatten top-level nested objects for value substitution.
  Object.assign(patchValues, flattenTemplateData(data));

  // Context for condition/loop evaluation: `data` overlaid with the raw
  // (pre-format) values of any field a fill step rewrote to a display string
  // (today: date fields, see CONDITION_RAW_VALUES). Overlay keys are exact
  // dotted field paths, which `resolvePath` prefers over the nested walk, so
  // `{{#if signing_date > "2028-01-01"}}` compares the ISO value while
  // substitution still uses the localized text in `data`/`patchValues`. Plain
  // `data` when there is no overlay keeps the prior behavior untouched.
  const conditionData: Record<string, unknown> =
    conditionValues && Object.keys(conditionValues).length > 0
      ? { ...data, ...conditionValues }
      : data;

  const process = (
    bodyEl: slimdom.Element,
    contextData: Record<string, unknown>,
  ): void => {
    // Iterate until no more directives remain. Each pass
    // resolves top-level blocks; nested blocks that were
    // inside a kept branch become top-level in the next pass.
    const MAX_PASSES = 20;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const directives = scanBlockDirectives(bodyEl);
      if (directives.length === 0) {
        return;
      }

      const { blocks, errors } = parseBlockTree(directives);
      allErrors.push(...errors);

      if (blocks.length === 0) {
        return;
      }

      // Process blocks in reverse order to preserve paragraph
      // indices (same pattern as apply-edits.ts)
      const sortedBlocks = [...blocks].toSorted((a, b) => {
        const aStart = a.directiveParagraphs[0] ?? 0;
        const bStart = b.directiveParagraphs[0] ?? 0;
        return bStart - aStart;
      });

      for (const block of sortedBlocks) {
        // Re-fetch paragraphs after each mutation
        const ps = bodyEl.getElementsByTagNameNS(W_NS, "p");

        if (block.kind === "if") {
          processIfBlock(ps, block, contextData, namedConditions);
        } else {
          processEachBlock(bodyEl, ps, block, contextData);
        }
      }
    }

    // MAX_PASSES exhausted — report remaining directives
    const remaining = scanBlockDirectives(bodyEl);
    if (remaining.length > 0) {
      const first = remaining[0];
      if (first) {
        allErrors.push({
          message: `Template nesting too deep: ${remaining.length} unresolved directive(s) after ${MAX_PASSES} passes`,
          paragraphIndex: first.paragraphIndex,
          directive: "MAX_PASSES exceeded",
        });
      }
    }
  };

  const processIfBlock = (
    paragraphs: slimdom.Element[],
    block: IfBlock,
    contextData: Record<string, unknown>,
    conditions?: NamedCondition[],
  ): void => {
    // Find the winning branch
    let winningBranch: IfBranch | null = null;
    for (const branch of block.branches) {
      if (branch.condition === "") {
        // else branch — always wins
        winningBranch = branch;
        break;
      }
      if (evaluateCondition(branch.condition, contextData, conditions)) {
        winningBranch = branch;
        break;
      }
    }

    // Collect all paragraph indices in this block
    const firstDirective = block.directiveParagraphs[0] ?? 0;
    // directiveParagraphs always has opening + closing entries
    const lastDirective = block.directiveParagraphs.at(-1) ?? 0;

    // We need to remove everything from firstDirective to
    // lastDirective, then insert the winning branch's content.

    if (winningBranch) {
      // Content paragraphs to keep
      const keepStart = winningBranch.contentStart;
      const keepEnd = winningBranch.contentEnd;

      // Remove from lastDirective down to keepEnd (reverse)
      for (let j = lastDirective; j >= keepEnd; j--) {
        const p = paragraphs[j];
        if (p) {
          p.parentNode?.removeChild(p);
        }
      }

      // Remove from keepStart-1 down to firstDirective
      for (let j = keepStart - 1; j >= firstDirective; j--) {
        const p = paragraphs[j];
        if (p) {
          p.parentNode?.removeChild(p);
        }
      }
    } else {
      // No branch matched — remove all paragraphs in range
      for (let j = lastDirective; j >= firstDirective; j--) {
        const p = paragraphs[j];
        if (p) {
          p.parentNode?.removeChild(p);
        }
      }
    }
  };

  // Build a loop iteration's evaluation context: `contextData` overlaid with
  // the item's own fields, the item under its array name (so `{{#each
  // arrayPath.sub}}` resolves), and the row's raw (pre-format) date overlay.
  const buildItemContext = (
    contextData: Record<string, unknown>,
    item: unknown,
    arrayPath: string,
    itemIdx: number,
  ): Record<string, unknown> => {
    const itemContext: Record<string, unknown> = { ...contextData };
    if (isRecord(item)) {
      Object.assign(itemContext, item);
      itemContext[arrayPath] = item;
      // A nested `{{#each arrayPath.sub}}` was rewritten to its per-item key
      // (see rewriteNestedEachExpr); expose the item's arrays under that key so
      // the inner loop resolves them in the recursion.
      for (const [field, value] of Object.entries(item)) {
        if (Array.isArray(value)) {
          itemContext[eachKey(arrayPath, itemIdx, field)] = value;
        }
      }
      applyRowRawOverlay(itemContext, conditionValues, arrayPath, itemIdx);
    }
    return itemContext;
  };

  // Register a loop item's values for later substitution (recursively for
  // nested objects so deep paths like address.city resolve).
  const registerItem = (
    item: unknown,
    arrayPath: string,
    itemIdx: number,
  ): void => {
    if (isRecord(item)) {
      registerItemPatchValues(patchValues, item, arrayPath, itemIdx, "");
    } else if (typeof item === "string") {
      // Simple array of strings: {{arrayPath.value}} or raw {{__each_arrayPath_N}}
      patchValues[`__each_${arrayPath}_${itemIdx}`] = item;
    }
  };

  // Resolve `{{@index}}`/`{{@count}}` (innermost-loop only, via `tokenMask`)
  // and loop-scoped `{{@num:Key}}`/`{{@ref:Key}}` on a copy's content
  // paragraphs. Placeholder rewriting is done separately over whole units.
  const rewriteContentParagraphs = (
    contentParas: readonly slimdom.Element[],
    options: {
      tokenMask: readonly boolean[];
      localNumKeys: ReadonlySet<string>;
      expansionId: number;
      itemIdx: number;
      itemCount: number;
    },
  ): void => {
    for (const [k, cp] of contentParas.entries()) {
      if (options.tokenMask[k]) {
        rewriteIterationTokens(cp, options.itemIdx, options.itemCount);
      }
      if (options.localNumKeys.size > 0) {
        scopeNumberingMarkers(cp, {
          localKeys: options.localNumKeys,
          expansionId: options.expansionId,
          index: options.itemIdx,
        });
      }
    }
  };

  // Clear a straddling marker's text so the scanner stops treating it as a
  // directive (avoids an unresolved-directive loop), then report the error.
  const reportAmbiguousPlacement = (
    openerP: slimdom.Element,
    closerP: slimdom.Element,
    block: EachBlock,
    openingIdx: number,
  ): void => {
    rewriteTextNodes(openerP, () => "");
    rewriteTextNodes(closerP, () => "");
    allErrors.push({
      message:
        "{{#each}} and {{/each}} must sit in the same table row or share a block-level parent; a marker pair that straddles a table boundary is not supported",
      paragraphIndex: openingIdx,
      directive: `{{#each ${block.arrayPath}}}`,
    });
  };

  // Row-repeat: the opener/closer confined to one `w:tr`. Clone the row per
  // item, strip the marker paragraphs, and rewrite per item.
  const expandRow = (
    row: slimdom.Element,
    openerP: slimdom.Element,
    closerP: slimdom.Element,
    block: EachBlock,
    items: readonly unknown[],
    contextData: Record<string, unknown>,
    doc: slimdom.Document,
  ): void => {
    const tbl = row.parentNode;
    if (!tbl) {
      return;
    }

    const rowParas = [...row.getElementsByTagNameNS(W_NS, TAG.paragraph)];
    const openerOrdinal = rowParas.indexOf(openerP);
    const closerOrdinal = rowParas.indexOf(closerP);
    const isMarker = (i: number): boolean =>
      i === openerOrdinal || i === closerOrdinal;
    const contentParas = rowParas.filter((_, i) => !isMarker(i));

    const tokenMask = directEachBodyMask(contentParas);
    const localNumKeys = collectNumKeys(contentParas);
    const expansionId = eachExpansionCount;
    eachExpansionCount += 1;

    const finalRows: slimdom.Element[] = [];
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];
      const clonedRow = cloneElement(row, doc);
      const clonedParas = [
        ...clonedRow.getElementsByTagNameNS(W_NS, TAG.paragraph),
      ];

      const openerClone = clonedParas[openerOrdinal];
      const closerClone = clonedParas[closerOrdinal];
      if (openerClone) {
        stripRowMarkerParagraph(openerClone, doc);
      }
      if (closerClone && closerClone !== openerClone) {
        stripRowMarkerParagraph(closerClone, doc);
      }

      rewriteEachPlaceholders(clonedRow, block.arrayPath, itemIdx);
      rewriteNestedEachExpr(clonedRow, block.arrayPath, itemIdx);
      const clonedContentParas = clonedParas.filter((_, i) => !isMarker(i));
      rewriteContentParagraphs(clonedContentParas, {
        tokenMask,
        localNumKeys,
        expansionId,
        itemIdx,
        itemCount: items.length,
      });
      registerItem(item, block.arrayPath, itemIdx);

      const hasNested = clonedContentParas.some((p) =>
        DIRECTIVE_RE.test(paragraphText(p)),
      );
      if (hasNested) {
        const itemContext = buildItemContext(
          contextData,
          item,
          block.arrayPath,
          itemIdx,
        );
        const tempBody = doc.createElementNS(W_NS, "w:body");
        const tempTbl = doc.createElementNS(W_NS, "w:tbl");
        tempBody.append(tempTbl);
        tempTbl.append(clonedRow);
        process(tempBody, itemContext);
        for (const child of [...tempTbl.childNodes]) {
          if (isElement(child)) {
            finalRows.push(child);
          }
        }
      } else {
        finalRows.push(clonedRow);
      }
    }

    const insertionRef = row.nextSibling;
    tbl.removeChild(row);
    for (const r of finalRows) {
      if (insertionRef) {
        tbl.insertBefore(r, insertionRef);
      } else {
        tbl.append(r);
      }
    }
  };

  // Block repeat: opener/closer are block-level siblings. Clone every block
  // child (w:p AND w:tbl) between them as a unit per item.
  const expandBlock = (
    openerP: slimdom.Element,
    closerP: slimdom.Element,
    block: EachBlock,
    items: readonly unknown[],
    contextData: Record<string, unknown>,
    doc: slimdom.Document,
  ): void => {
    const parent = openerP.parentNode;
    if (!parent) {
      return;
    }

    const contentUnits: slimdom.Element[] = [];
    for (
      let n: slimdom.Node | null = openerP.nextSibling;
      n && n !== closerP;
      n = n.nextSibling
    ) {
      if (isElement(n)) {
        contentUnits.push(n);
      }
    }

    const contentParas = paragraphsInUnits(contentUnits);
    const tokenMask = directEachBodyMask(contentParas);
    const localNumKeys = collectNumKeys(contentParas);
    const expansionId = eachExpansionCount;
    eachExpansionCount += 1;

    const finalUnits: slimdom.Element[] = [];
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];
      const clones = contentUnits.map((u) => cloneElement(u, doc));
      const clonedParas = paragraphsInUnits(clones);

      for (const clone of clones) {
        rewriteEachPlaceholders(clone, block.arrayPath, itemIdx);
        rewriteNestedEachExpr(clone, block.arrayPath, itemIdx);
      }
      rewriteContentParagraphs(clonedParas, {
        tokenMask,
        localNumKeys,
        expansionId,
        itemIdx,
        itemCount: items.length,
      });
      registerItem(item, block.arrayPath, itemIdx);

      const hasNested = clonedParas.some((p) =>
        DIRECTIVE_RE.test(paragraphText(p)),
      );
      if (hasNested) {
        const itemContext = buildItemContext(
          contextData,
          item,
          block.arrayPath,
          itemIdx,
        );
        const tempBody = doc.createElementNS(W_NS, "w:body");
        for (const clone of clones) {
          tempBody.append(clone);
        }
        process(tempBody, itemContext);
        for (const child of [...tempBody.childNodes]) {
          if (isElement(child)) {
            finalUnits.push(child);
          }
        }
      } else {
        finalUnits.push(...clones);
      }
    }

    // Insertion reference captured before removal; it sits after closerP and
    // survives removing the opener…closer range.
    const insertionRef = closerP.nextSibling;
    const toRemove: slimdom.Node[] = [];
    for (let n: slimdom.Node | null = openerP; n; n = n.nextSibling) {
      toRemove.push(n);
      if (n === closerP) {
        break;
      }
    }
    for (const n of toRemove) {
      parent.removeChild(n);
    }

    for (const u of finalUnits) {
      if (insertionRef) {
        parent.insertBefore(u, insertionRef);
      } else {
        parent.append(u);
      }
    }
  };

  const processEachBlock = (
    bodyEl: slimdom.Element,
    paragraphs: slimdom.Element[],
    block: EachBlock,
    contextData: Record<string, unknown>,
  ): void => {
    const arrayData = resolvePath(block.arrayPath, contextData);
    const items = isUnknownArray(arrayData) ? arrayData : [];

    const doc = bodyEl.ownerDocument;
    if (!doc) {
      return;
    }

    // SAFETY: directiveParagraphs always has opening + closing entries.
    const openingIdx = block.directiveParagraphs[0] ?? 0;
    const closingIdx = block.directiveParagraphs.at(-1) ?? 0;
    const openerP = paragraphs[openingIdx];
    const closerP = paragraphs[closingIdx];
    if (!openerP || !closerP) {
      return;
    }

    const openerRow = ancestorByLocalName(openerP, TAG.row);
    const closerRow = ancestorByLocalName(closerP, TAG.row);

    // Row-repeat: both markers confined to the same table row.
    if (openerRow && openerRow === closerRow) {
      expandRow(openerRow, openerP, closerP, block, items, contextData, doc);
      return;
    }

    // Ambiguous: one marker in a row and the other outside it, the two in
    // different rows, or non-sibling block-level markers. Reject rather than
    // emit corrupt XML.
    if (openerRow || closerRow || openerP.parentNode !== closerP.parentNode) {
      reportAmbiguousPlacement(openerP, closerP, block, openingIdx);
      return;
    }

    expandBlock(openerP, closerP, block, items, contextData, doc);
  };

  process(body, conditionData);

  return { patchValues, errors: allErrors };
};

// ── Each-expansion helpers ───────────────────────────────

/** Generate the synthetic patch key for an each-expanded field. */
export const eachKey = (
  arrayPath: string,
  index: number,
  field: string,
): string => `__each_${arrayPath}_${index}_${field}`;

/**
 * Recursively register patch values for an array item,
 * flattening nested objects into dot-joined keys so that
 * deep paths like `{{sellers.address.city}}` resolve.
 */
export const registerItemPatchValues = (
  patchValues: Record<string, RichPatchValue>,
  item: Record<string, unknown>,
  arrayPath: string,
  itemIdx: number,
  prefix: string,
): void => {
  for (const [field, value] of Object.entries(item)) {
    const fullField = prefix ? `${prefix}.${field}` : field;
    const key = eachKey(arrayPath, itemIdx, fullField);
    if (typeof value === "string") {
      patchValues[key] = value;
    } else if (typeof value === "number") {
      patchValues[key] = String(value);
    } else if (typeof value === "boolean") {
      patchValues[key] = String(value);
    } else if (isRichPatchValue(value)) {
      patchValues[key] = value;
    } else if (Array.isArray(value)) {
      // Arrays inside items are not expanded
    } else if (isRecord(value)) {
      registerItemPatchValues(
        patchValues,
        value,
        arrayPath,
        itemIdx,
        fullField,
      );
    }
  }
};

/** Apply `rewrite` to every `w:t` text node under `root`. */
const rewriteTextNodes = (
  root: slimdom.Element,
  rewrite: (text: string) => string,
): void => {
  const walk = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }
    if (node.localName === "t" && node.namespaceURI === W_NS) {
      const text = node.textContent ?? "";
      const rewritten = rewrite(text);
      if (rewritten !== text) {
        node.textContent = rewritten;
      }
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(root);
};

/**
 * Rewrite `{{arrayPath.field}}` → `{{__each_arrayPath_N_field}}`
 * in a plain text string. Shared with the inline-each expander so
 * both passes rewrite item field references identically.
 */
export const rewriteEachPlaceholdersInText = (
  text: string,
  arrayPath: string,
  index: number,
): string => {
  const re = new RegExp(
    `\\{\\{${escapeRegExp(arrayPath)}\\.([.\\p{L}\\p{N}_-]+)\\}\\}`,
    "gu",
  );
  return text.replace(
    re,
    (_match, field: string) => `{{${eachKey(arrayPath, index, field)}}}`,
  );
};

/**
 * Rewrite `{{arrayPath.field}}` → `{{__each_arrayPath_N_field}}`
 * in all `w:t` nodes of a paragraph (or any element subtree).
 */
const rewriteEachPlaceholders = (
  root: slimdom.Element,
  arrayPath: string,
  index: number,
): void => {
  rewriteTextNodes(root, (text) =>
    rewriteEachPlaceholdersInText(text, arrayPath, index),
  );
};

/**
 * Rewrite a nested loop opener `{{#each arrayPath.sub}}` → `{{#each
 * __each_arrayPath_N_sub}}` so the inner loop, expanded in a later per-item
 * recursion, resolves against the outer item's array (registered under the same
 * key in the iteration context) and its synthetic keys stay unique per outer
 * item. Unprefixed nested loops (`{{#each other}}`) are left untouched and
 * resolve through the item context by name.
 */
const rewriteNestedEachExpr = (
  root: slimdom.Element,
  arrayPath: string,
  index: number,
): void => {
  const re = new RegExp(
    `(\\{\\{\\s*#each\\s+)${escapeRegExp(arrayPath)}\\.([.\\p{L}\\p{N}_-]+)(\\s*\\}\\})`,
    "gu",
  );
  rewriteTextNodes(root, (text) =>
    text.replace(
      re,
      (_match, pre: string, sub: string, post: string) =>
        `${pre}${eachKey(arrayPath, index, sub)}${post}`,
    ),
  );
};

/**
 * Resolve `{{@index}}`/`{{@count}}` in all `w:t` nodes of a paragraph for the
 * iteration at `index` of a loop with `count` items.
 */
const rewriteIterationTokens = (
  paragraph: slimdom.Element,
  index: number,
  count: number,
): void => {
  rewriteTextNodes(paragraph, (text) =>
    rewriteIterationTokensInText(text, index, count),
  );
};

/**
 * For each content paragraph of a loop, whether it belongs *directly* to that
 * loop's body (each-nesting depth 0) rather than to a nested `{{#each}}`. A
 * nested `{{#each}}` opener line and its inner paragraphs are depth > 0; the
 * matching `{{/each}}` line closes back to the enclosing depth. Drives which
 * paragraphs get their `{{@index}}`/`{{@count}}` tokens resolved by this loop.
 */
const directEachBodyMask = (
  paragraphs: readonly slimdom.Element[],
): boolean[] => {
  const mask: boolean[] = [];
  let depth = 0;
  for (const p of paragraphs) {
    const match = DIRECTIVE_RE.exec(paragraphText(p));
    const tag = match?.[1];
    if (tag === "/each") {
      depth -= 1;
    }
    mask.push(depth === 0);
    if (tag === "#each") {
      depth += 1;
    }
  }
  return mask;
};

/**
 * Resolve the per-iteration tokens `{{@index}}` and `{{@count}}` in a plain
 * text string: `{{@index}}` → the 1-based position (`index + 1`), `{{@count}}`
 * → the loop's item count. Shared by the block and inline each expanders so
 * both resolve iteration tokens identically.
 *
 * Composition: the caller applies this only to text that belongs to the
 * *innermost* enclosing loop (the block expander skips paragraphs nested in an
 * inner `{{#each}}`, the inline expander has no nested loops by grammar). An
 * outer loop therefore leaves a nested loop's tokens untouched, and they are
 * resolved when that inner loop expands — so `{{@index}}`/`{{@count}}` always
 * bind to the closest loop. It also composes with field substitution: tokens
 * and `{{path.field}}` placeholders are disjoint, so the order of the two
 * rewrites does not matter.
 */
export const rewriteIterationTokensInText = (
  text: string,
  index: number,
  count: number,
): string =>
  text
    .replace(indexPattern(), String(index + 1))
    .replace(countPattern(), String(count));

// ── Loop-scoped clause numbering ─────────────────────────

/** Collect `{{@num:Key}}` keys appearing in a plain text string. */
export const collectNumKeysInText = (text: string): Set<string> => {
  const keys = new Set<string>();
  for (const match of text.matchAll(numPattern())) {
    const key = match[1];
    if (key !== undefined) {
      keys.add(key);
    }
  }
  return keys;
};

/** Collect `{{@num:Key}}` keys appearing in the given paragraphs. */
const collectNumKeys = (
  paragraphs: readonly slimdom.Element[],
): Set<string> => {
  const keys = new Set<string>();
  for (const p of paragraphs) {
    for (const key of collectNumKeysInText(paragraphText(p))) {
      keys.add(key);
    }
  }
  return keys;
};

/**
 * Namespace for the synthetic per-iteration numbering key. Block and inline
 * loops expand independently but share the document's numbering key space (the
 * raw-XML `applyNumbering` pass runs once over both), so a distinct infix keeps
 * an identical base `@num` key used in both a block and an inline loop from
 * colliding on the same number.
 */
type NumberingScope = "each" | "ieach";

/** Synthetic per-iteration key for a loop-local `@num`/`@ref`. */
const iterationNumKey = (
  key: string,
  scope: NumberingScope,
  expansionId: number,
  index: number,
): string => `${key}__${scope}${expansionId}_${index}`;

type ScopeNumberingOptions = {
  localKeys: ReadonlySet<string>;
  expansionId: number;
  index: number;
  /** Defaults to the block-loop namespace. */
  scope?: NumberingScope;
};

/**
 * Rewrite loop-local `{{@num:Key}}` / `{{@ref:Key}}` markers in a plain text
 * string to per-iteration keys so numbering.ts assigns each expanded copy its
 * own number and intra-iteration refs follow it. Only keys present in
 * `localKeys` (those *defined* by a `{{@num:Key}}` in the loop body) are
 * scoped, so a `@ref` to a shared clause outside the loop still resolves.
 * Shared by the block expander (per `w:t` node) and the inline expander (per
 * rendered span).
 */
export const scopeIterationNumberingInText = (
  text: string,
  { localKeys, expansionId, index, scope = "each" }: ScopeNumberingOptions,
): string => {
  const rewriteSigil = (input: string, sigil: "num" | "ref", re: RegExp) =>
    input.replace(re, (match, key: string) =>
      localKeys.has(key)
        ? `{{@${sigil}:${iterationNumKey(key, scope, expansionId, index)}}}`
        : match,
    );
  return rewriteSigil(
    rewriteSigil(text, "num", numPattern()),
    "ref",
    refPattern(),
  );
};

/**
 * DOM wrapper over {@link scopeIterationNumberingInText}: rewrite loop-local
 * numbering markers in every `w:t` node of a paragraph. Markers split across
 * runs are out of grammar, matching the raw-XML numbering pass.
 */
const scopeNumberingMarkers = (
  paragraph: slimdom.Element,
  options: ScopeNumberingOptions,
): void => {
  rewriteTextNodes(paragraph, (text) =>
    scopeIterationNumberingInText(text, options),
  );
};

// ── Word list-numbering integrity ────────────────────────

/** slimdom can surface `w:` attributes either way; try both. */
const readWAttr = (el: slimdom.Element, name: string): string | null =>
  el.getAttributeNS(W_NS, name) ?? el.getAttribute(`w:${name}`);

/** `w:numId="0"` is the explicit "no numbering" override — always valid. */
const NUM_ID_NONE = "0";

/**
 * Collect `w:numId` values whose definition chain resolves
 * (`w:num` → `w:abstractNum`). Loop expansion clones list
 * paragraphs verbatim, so a numId left dangling in the template
 * would be multiplied across iterations; callers prune those
 * with {@link pruneDanglingNumPr} instead.
 */
export const collectValidNumIds = (
  numberingXml: string | null,
): ReadonlySet<string> => {
  const valid = new Set<string>([NUM_ID_NONE]);
  if (numberingXml === null) {
    return valid;
  }

  const doc = slimdom.parseXmlDocument(numberingXml);
  const abstractIds = new Set<string>();
  for (const abstractNum of doc.getElementsByTagNameNS(W_NS, "abstractNum")) {
    const id = readWAttr(abstractNum, "abstractNumId");
    if (id !== null) {
      abstractIds.add(id);
    }
  }

  for (const num of doc.getElementsByTagNameNS(W_NS, "num")) {
    const numId = readWAttr(num, "numId");
    if (numId === null) {
      continue;
    }
    const abstractRef = num.getElementsByTagNameNS(W_NS, "abstractNumId").at(0);
    const abstractId = abstractRef ? readWAttr(abstractRef, "val") : null;
    if (abstractId !== null && abstractIds.has(abstractId)) {
      valid.add(numId);
    }
  }

  return valid;
};

/**
 * Remove `w:numPr` elements whose `w:numId` has no resolvable
 * numbering definition. Word silently drops the numbering for
 * such paragraphs while other consumers differ; removing the
 * dangling reference makes the filled document render the same
 * everywhere. Valid references are kept untouched so cloned
 * iterations share the original numId (one continuous
 * sequence — see the module doc).
 */
export const pruneDanglingNumPr = (
  body: slimdom.Element,
  validNumIds: ReadonlySet<string>,
): void => {
  for (const numPr of body.getElementsByTagNameNS(W_NS, "numPr")) {
    const numIdEl = numPr.getElementsByTagNameNS(W_NS, "numId").at(0);
    if (!numIdEl) {
      // Style-inherited numbering; nothing to validate here.
      continue;
    }
    const numId = readWAttr(numIdEl, "val");
    if (numId === null || validNumIds.has(numId)) {
      continue;
    }
    numPr.parentNode?.removeChild(numPr);
  }
};

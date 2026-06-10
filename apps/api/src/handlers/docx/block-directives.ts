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
  evaluateCondition,
  hasBlockDirectivePattern,
  numPattern,
  refPattern,
  resolvePath,
} from "@stll/template-conditions";

import { isElement, paragraphText, W_NS } from "./ooxml";
import type {
  Block,
  BlockDirective,
  BlockDirectiveKind,
  EachBlock,
  IfBlock,
  IfBranch,
  NamedCondition,
  RichPatchValue,
  TemplateData,
  TemplateStructureError,
} from "./types";

export { evaluateCondition, resolvePath };

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

    const tag = match[1];
    const rawExpr = match[2];
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

// ── Deep clone for slimdom nodes ─────────────────────────

const cloneParagraph = (
  p: slimdom.Element,
  doc: slimdom.Document,
): slimdom.Element => doc.importNode(p, true);

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
): ProcessResult => {
  const patchValues: Record<string, RichPatchValue> = {};
  const allErrors: TemplateStructureError[] = [];

  // Distinguishes sibling loops (possibly over the same array) so
  // their iteration-scoped numbering keys can never collide.
  let eachExpansionCount = 0;

  // Flatten top-level nested objects for value substitution.
  Object.assign(patchValues, flattenTemplateData(data));

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

    // Content paragraphs to clone (between opening and closing)
    const contentParagraphs: slimdom.Element[] = [];
    for (let j = block.contentStart; j < block.contentEnd; j++) {
      const p = paragraphs[j];
      if (p) {
        contentParagraphs.push(p);
      }
    }

    // SAFETY: directiveParagraphs always has at least 2 entries
    // directiveParagraphs always has opening + closing entries
    const closingIdx = block.directiveParagraphs.at(-1) ?? 0;

    // {{@num:Key}} keys defined inside the loop body must number
    // per expanded copy, not once for all iterations (a repeated
    // key reuses its first number — see numbering.ts). Scope them
    // with a per-expansion, per-iteration suffix. Keys defined
    // outside the body are left alone so `@ref`s to shared
    // clauses keep resolving from within the loop.
    const localNumKeys = collectNumKeys(contentParagraphs);
    const expansionId = eachExpansionCount;
    eachExpansionCount += 1;

    // Create expanded paragraphs for each item
    const expandedGroups: slimdom.Element[][] = [];
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];
      const group: slimdom.Element[] = [];

      for (const contentP of contentParagraphs) {
        const cloned = cloneParagraph(contentP, doc);

        // Rewrite {{arrayPath.field}} → {{__each_arrayPath_N_field}}
        rewriteEachPlaceholders(cloned, block.arrayPath, itemIdx);

        if (localNumKeys.size > 0) {
          scopeNumberingMarkers(cloned, {
            localKeys: localNumKeys,
            expansionId,
            index: itemIdx,
          });
        }

        group.push(cloned);
      }

      // Register patch values for this item (recursively for
      // nested objects so deep paths like address.city resolve)
      if (isRecord(item)) {
        registerItemPatchValues(
          patchValues,
          item,
          block.arrayPath,
          itemIdx,
          "",
        );
      } else if (typeof item === "string") {
        // Simple array of strings: {{arrayPath.value}} or
        // raw {{__each_arrayPath_N}}
        const key = `__each_${block.arrayPath}_${itemIdx}`;
        patchValues[key] = item;
      }

      expandedGroups.push(group);
    }

    // Now process conditionals inside each expanded group
    // by creating a temporary wrapper, running
    // processBlockDirectives recursively, then extracting
    // the surviving paragraphs
    const finalParagraphs: slimdom.Element[] = [];
    for (let itemIdx = 0; itemIdx < expandedGroups.length; itemIdx++) {
      const group = expandedGroups[itemIdx];
      if (!group) {
        continue;
      }
      const item = items[itemIdx];

      // Build context for this iteration
      const itemContext: Record<string, unknown> = {
        ...contextData,
      };
      if (isRecord(item)) {
        Object.assign(itemContext, item);
        // Also keep the array accessible by name
        itemContext[block.arrayPath] = item;
      }

      // Check if any group paragraph has block directives
      const hasNested = group.some((p) => {
        const text = paragraphText(p);
        return DIRECTIVE_RE.test(text);
      });

      if (hasNested) {
        // Create temporary body with the group paragraphs
        const tempBody = doc.createElementNS(W_NS, "w:body");
        for (const p of group) {
          tempBody.append(p);
        }
        // Recursively process
        process(tempBody, itemContext);
        // Collect surviving paragraphs
        const survivors = tempBody.getElementsByTagNameNS(W_NS, "p");
        for (const s of survivors) {
          finalParagraphs.push(s);
        }
      } else {
        finalParagraphs.push(...group);
      }
    }

    // Save insertion reference before removing paragraphs.
    // Use the closing directive's nextSibling (guaranteed to
    // be a direct child of bodyEl, unlike getElementsByTagNameNS
    // which returns nested descendants too).
    const openingIdx = block.directiveParagraphs[0] ?? 0;
    const closingP =
      closingIdx < paragraphs.length ? paragraphs[closingIdx] : null;
    const insertionRef = closingP?.nextSibling ?? null;

    // Remove original content and directive paragraphs
    // (reverse order to preserve indices)
    for (let j = closingIdx; j >= openingIdx; j--) {
      const p = paragraphs[j];
      if (p) {
        p.parentNode?.removeChild(p);
      }
    }

    // Insert expanded paragraphs at the saved position
    for (const p of finalParagraphs) {
      if (insertionRef) {
        bodyEl.insertBefore(p, insertionRef);
      } else {
        bodyEl.append(p);
      }
    }
  };

  process(body, data);

  return { patchValues, errors: allErrors };
};

// ── Each-expansion helpers ───────────────────────────────

/** Generate the synthetic patch key for an each-expanded field. */
const eachKey = (arrayPath: string, index: number, field: string): string =>
  `__each_${arrayPath}_${index}_${field}`;

/**
 * Recursively register patch values for an array item,
 * flattening nested objects into dot-joined keys so that
 * deep paths like `{{sellers.address.city}}` resolve.
 */
const registerItemPatchValues = (
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
 * in all `w:t` nodes of a paragraph.
 */
const rewriteEachPlaceholders = (
  paragraph: slimdom.Element,
  arrayPath: string,
  index: number,
): void => {
  const re = new RegExp(
    `\\{\\{${escapeRegExp(arrayPath)}\\.([.\\p{L}\\p{N}_]+)\\}\\}`,
    "gu",
  );
  rewriteTextNodes(paragraph, (text) =>
    text.replace(
      re,
      (_match, field: string) => `{{${eachKey(arrayPath, index, field)}}}`,
    ),
  );
};

// ── Loop-scoped clause numbering ─────────────────────────

/** Collect `{{@num:Key}}` keys appearing in the given paragraphs. */
const collectNumKeys = (
  paragraphs: readonly slimdom.Element[],
): Set<string> => {
  const keys = new Set<string>();
  for (const p of paragraphs) {
    for (const match of paragraphText(p).matchAll(numPattern())) {
      const key = match[1];
      if (key !== undefined) {
        keys.add(key);
      }
    }
  }
  return keys;
};

/** Synthetic per-iteration key for a loop-local `@num`/`@ref`. */
const iterationNumKey = (
  key: string,
  expansionId: number,
  index: number,
): string => `${key}__each${expansionId}_${index}`;

type ScopeNumberingOptions = {
  localKeys: ReadonlySet<string>;
  expansionId: number;
  index: number;
};

/**
 * Rewrite loop-local `{{@num:Key}}` / `{{@ref:Key}}` markers to
 * per-iteration keys so numbering.ts assigns each expanded copy
 * its own number and intra-iteration refs follow it. Nested
 * loops compose: each enclosing expansion appends its own
 * suffix, so every (outer, inner) iteration pair stays unique.
 * Operates per `w:t` node; markers split across runs are out of
 * grammar, matching the raw-XML numbering pass.
 */
const scopeNumberingMarkers = (
  paragraph: slimdom.Element,
  { localKeys, expansionId, index }: ScopeNumberingOptions,
): void => {
  const numRe = numPattern();
  const refRe = refPattern();
  const rewriteSigil = (text: string, sigil: "num" | "ref", re: RegExp) =>
    text.replace(re, (match, key: string) =>
      localKeys.has(key)
        ? `{{@${sigil}:${iterationNumKey(key, expansionId, index)}}}`
        : match,
    );
  rewriteTextNodes(paragraph, (text) =>
    rewriteSigil(rewriteSigil(text, "num", numRe), "ref", refRe),
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

/**
 * DOCX block-directive pre-processor.
 *
 * Scans OOXML body paragraphs for block directives
 * ({{#if}}, {{#each}}, etc.), evaluates conditions, expands
 * loops, and strips directive paragraphs — all before
 * `patchDocument()` runs for value substitution.
 *
 * Templates without block directives skip all processing
 * (fast-path check via regex on raw XML).
 */

import type * as slimdom from "slimdom";

import { evaluateCondition, resolvePath } from "@stella/template-conditions";

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

/** Matches a block directive as the sole paragraph content. */
const DIRECTIVE_RE =
  /^\s*\{\{(#if|#elseif|#else|#each|\/if|\/each)\s*(.*?)\}\}\s*$/;

/** Fast-path: does the raw XML contain any block directives? */
export const HAS_BLOCK_DIRECTIVES_RE = /\{\{[#/]/;

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
      } else if (
        d.kind === "endif" ||
        d.kind === "endeach" ||
        d.kind === "elseif" ||
        d.kind === "else"
      ) {
        // These are handled by their parent parsers
        break;
      } else {
        i++;
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

      if (d.kind === "endeach") {
        errors.push({
          message: "Unexpected {{/each}} inside {{#if}} block",
          paragraphIndex: d.paragraphIndex,
          directive: "{{/each}}",
        });
        i++;
        break;
      }

      i++;
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

      if (d.kind === "elseif" || d.kind === "else") {
        errors.push({
          message: `Unexpected {{#${d.kind}}} inside {{#each}} block`,
          paragraphIndex: d.paragraphIndex,
          directive: `{{#${d.kind}}}`,
        });
        i++;
        continue;
      }

      i++;
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
      const tag =
        d.kind === "endif"
          ? "{{/if}}"
          : d.kind === "endeach"
            ? "{{/each}}"
            : `{{#${d.kind}}}`;
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
    } else if (typeof value === "object" && value !== null) {
      Object.assign(result, flattenTemplateData(value, fullKey));
    }
  }

  return result;
};

// ── w:t node rewriting ───────────────────────────────────

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  // Flatten top-level nested objects for patchDocument
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

    // Create expanded paragraphs for each item
    const expandedGroups: slimdom.Element[][] = [];
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];
      const group: slimdom.Element[] = [];

      for (const contentP of contentParagraphs) {
        const cloned = cloneParagraph(contentP, doc);

        // Rewrite {{arrayPath.field}} → {{__each_arrayPath_N_field}}
        rewriteEachPlaceholders(cloned, block.arrayPath, itemIdx);

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

/**
 * Rewrite `{{arrayPath.field}}` → `{{__each_arrayPath_N_field}}`
 * in all `w:t` nodes of a paragraph.
 */
const rewriteEachPlaceholders = (
  paragraph: slimdom.Element,
  arrayPath: string,
  index: number,
): void => {
  const walk = (node: slimdom.Node) => {
    if (isElement(node)) {
      if (node.localName === "t" && node.namespaceURI === W_NS) {
        const text = node.textContent ?? "";
        const re = new RegExp(
          `\\{\\{${escapeRegExp(arrayPath)}\\.([.\\p{L}\\p{N}_]+)\\}\\}`,
          "gu",
        );
        const rewritten = text.replace(
          re,
          (_match, field: string) => `{{${eachKey(arrayPath, index, field)}}}`,
        );
        if (rewritten !== text) {
          node.textContent = rewritten;
        }
      } else {
        for (const child of node.childNodes) {
          walk(child);
        }
      }
    }
  };
  walk(paragraph);
};

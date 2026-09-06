/**
 * Extended template discovery: infers the expected data schema
 * from a DOCX template containing placeholders, conditionals,
 * and loops.
 *
 * Returns backward-compatible `DiscoveredPlaceholder[]` plus
 * `DiscoveredField[]` with inferred kinds (string, boolean,
 * array, object), `structureErrors` for mismatched blocks, and
 * `warnings` for markers that parse but do not mean what the
 * author wrote (see `template-warnings.ts`).
 */

import { panic } from "better-result";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import { compareCodeUnit } from "@stll/collation";
import { parseCondition, type ConditionNode } from "@stll/template-conditions";

import { parseBlockTree, scanBlockDirectives } from "./block-directives";
import { PLACEHOLDER_RE } from "./discover-placeholders";
import { parseInlineConditions } from "./inline-conditions";
import {
  MAIN_DOCUMENT_PART_PATH,
  paragraphText,
  templateContentPartPaths,
  W_NS,
} from "./ooxml";
import {
  boundTemplateWarnings,
  collectParagraphWarnings,
  type TemplateWarning,
} from "./template-warnings";
import type {
  DiscoveredField,
  DiscoveredPlaceholder,
  DiscoveredTemplate,
  TemplateFieldKind,
  TemplateStructureError,
} from "./types";

// ── Field inference ──────────────────────────────────────

type FieldInfo = {
  kind: TemplateFieldKind;
  count: number;
  itemPaths: Set<string>;
};

type FieldAccumulator = Map<string, FieldInfo>;

/**
 * Register a field path with an inferred kind. If the field
 * already exists, the kind is promoted to the more specific one.
 */
const registerField = (
  acc: FieldAccumulator,
  path: string,
  kind: TemplateFieldKind,
): void => {
  const existing = acc.get(path);
  if (existing) {
    existing.count++;
    // Promote kind: array > object > string > boolean
    if (kindPriority(kind) > kindPriority(existing.kind)) {
      existing.kind = kind;
    }
  } else {
    acc.set(path, { kind, count: 1, itemPaths: new Set() });
  }
};

const kindPriority = (kind: TemplateFieldKind): number => {
  switch (kind) {
    case "boolean":
      return 0;
    case "string":
      return 1;
    case "object":
      return 2;
    case "array":
      return 3;
    default:
      return 0;
  }
};

type ConditionFieldOptions = {
  fields: FieldAccumulator;
  /** Every path the expression reads, accumulated across containers. */
  conditionPaths: Set<string>;
  condition: string;
  rowPaths?: readonly string[];
};

const registerConditionFields = ({
  condition,
  conditionPaths,
  fields,
  rowPaths = [],
}: ConditionFieldOptions): void => {
  const root = parseCondition(condition);
  if (!root) {
    return;
  }

  const registerPath = (path: string, kind: "boolean" | "string"): void => {
    registerField(fields, path, kind);
    conditionPaths.add(path);

    const isQualifiedRowPath = rowPaths.some(
      (rowPath) => path === rowPath || path.startsWith(`${rowPath}.`),
    );
    if (isQualifiedRowPath) {
      for (const rowPath of rowPaths) {
        const rowPrefix = `${rowPath}.`;
        if (path.startsWith(rowPrefix)) {
          fields.get(rowPath)?.itemPaths.add(path.slice(rowPrefix.length));
        }
      }
      return;
    }

    for (const rowPath of rowPaths) {
      registerField(fields, `${rowPath}.${path}`, kind);
      fields.get(rowPath)?.itemPaths.add(path);
    }
  };

  const visit = (node: ConditionNode): void => {
    if (node.type === "group") {
      for (const child of node.children) {
        visit(child);
      }
      return;
    }

    if (node.type === "compare") {
      if (node.left.type === "path") {
        registerPath(node.left.path, "string");
      }
      if (node.right.type === "path") {
        registerPath(node.right.path, "string");
      }
      return;
    }

    if (node.operand.type === "path") {
      registerPath(
        node.operand.path,
        node.op === "is_truthy" ? "boolean" : "string",
      );
    }
  };

  visit(root);
};

const qualifyRowScopedPath = (
  path: string,
  rowPaths: readonly string[] = [],
): string => {
  if (
    rowPaths.some(
      (rowPath) => path === rowPath || path.startsWith(`${rowPath}.`),
    )
  ) {
    return path;
  }
  const innermostRowPath = rowPaths.at(-1);
  return innermostRowPath === undefined ? path : `${innermostRowPath}.${path}`;
};

type RowScope = {
  declaredPath: string;
  scopedPath: string;
};

const rowScopePaths = (rowScopes: readonly RowScope[]): string[] =>
  rowScopes.map(({ scopedPath }) => scopedPath);

const qualifyRowScopedPlaceholder = (
  path: string,
  rowScopes: readonly RowScope[],
): string => {
  if (
    rowScopes.some(
      ({ scopedPath }) =>
        path === scopedPath || path.startsWith(`${scopedPath}.`),
    )
  ) {
    return path;
  }
  for (const { declaredPath, scopedPath } of rowScopes.toReversed()) {
    if (path === declaredPath) {
      return scopedPath;
    }
    const declaredPrefix = `${declaredPath}.`;
    if (path.startsWith(declaredPrefix)) {
      return `${scopedPath}.${path.slice(declaredPrefix.length)}`;
    }
  }
  return path;
};

const requireRowScopes = (
  arrayScopes: ReadonlyMap<number, readonly RowScope[]>,
  paragraphIndex: number,
): readonly RowScope[] => {
  const scopes = arrayScopes.get(paragraphIndex);
  if (scopes === undefined) {
    panic(`Missing loop scope for paragraph ${paragraphIndex}`);
  }
  return scopes;
};

// ── Condition map building ─────────────────────────────

/**
 * Negate a condition expression.
 *
 * - Simple: `isUK` → `!isUK`
 * - Already negated: `!isUK` → `isUK`
 * - Compound: `isUK and hasLicense` → `!(isUK and hasLicense)`
 *
 * Uses parentheses for compound expressions so that
 * `evaluateCondition` treats the negation as applying
 * to the entire sub-expression (De Morgan via grouping).
 */
const negateExpr = (expr: string): string => {
  const trimmed = expr.trim();
  if (trimmed.startsWith("!") && !trimmed.includes(" ")) {
    return trimmed.slice(1);
  }
  // Compound expression: wrap in parens to negate as a unit
  if (trimmed.includes(" ")) {
    return `!(${trimmed})`;
  }
  return `!${trimmed}`;
};

const wrapConjunctionPart = (expr: string): string =>
  expr.includes(" or ") ? `(${expr})` : expr;

const combineConditions = (
  outer: string | undefined,
  inner: string | undefined,
): string | undefined => {
  if (outer === undefined) {
    return inner;
  }
  if (inner === undefined) {
    return outer;
  }
  return `${wrapConjunctionPart(outer)} and ${wrapConjunctionPart(inner)}`;
};

const recordFieldCondition = (
  fieldConditions: Map<string, string | null>,
  name: string,
  condition: string | undefined,
): void => {
  const existing = fieldConditions.get(name);
  if (existing === null) {
    return;
  }
  if (condition === undefined) {
    fieldConditions.set(name, null);
    return;
  }
  if (existing === undefined) {
    fieldConditions.set(name, condition);
    return;
  }
  if (existing !== condition) {
    fieldConditions.set(name, null);
  }
};

/**
 * Build a paragraph-index-to-condition map by walking
 * the flat directive list with a stack. Handles
 * arbitrary nesting and elseif/else compound negation.
 *
 * Each directive marks a boundary; paragraphs between
 * boundaries inherit the current stack's combined
 * condition.
 */
const buildConditionMapFromRanges = (
  directives: {
    kind: string;
    expression: string;
    paragraphIndex: number;
  }[],
  paragraphCount: number,
): Map<number, string> => {
  type IfState = {
    /** Original directive expressions for all preceding
     *  branches (not compound; used for negation). */
    originalExprs: string[];
    currentBranchExpr: string;
  };

  const stack: IfState[] = [];

  /** Combine all stack frames into one expression.
   *  Wraps sub-expressions containing `or` in parens
   *  so `and` joining doesn't change precedence. */
  const currentFullCondition = (): string | undefined => {
    if (stack.length === 0) {
      return undefined;
    }
    let result: string | undefined;
    for (const frame of stack) {
      const expr = frame.currentBranchExpr;
      // Wrap in parens if the expression contains `or`
      // to preserve correct precedence when joined

      const wrapped = expr.includes(" or ") ? `(${expr})` : expr;
      result = result ? `${result} and ${wrapped}` : wrapped;
    }
    return result;
  };

  type Boundary = {
    paragraphIndex: number;
    condition: string | undefined;
  };

  const boundaries: Boundary[] = [];

  for (const d of directives) {
    if (d.kind === "if") {
      stack.push({
        originalExprs: [d.expression],
        currentBranchExpr: d.expression,
      });
      boundaries.push({
        paragraphIndex: d.paragraphIndex + 1,
        condition: currentFullCondition(),
      });
    } else if (d.kind === "elseif") {
      const frame = stack.at(-1);
      if (!frame) {
        continue;
      }
      // Wrap the elseif expression in parens if it
      // contains `or` to preserve precedence when joined

      const exprPart = d.expression.includes(" or ")
        ? `(${d.expression})`
        : d.expression;
      const parts = [...frame.originalExprs.map(negateExpr), exprPart];
      frame.currentBranchExpr = parts.join(" and ");
      frame.originalExprs.push(d.expression);
      boundaries.push({
        paragraphIndex: d.paragraphIndex + 1,
        condition: currentFullCondition(),
      });
    } else if (d.kind === "else") {
      const frame = stack.at(-1);
      if (!frame) {
        continue;
      }
      frame.currentBranchExpr = frame.originalExprs
        .map(negateExpr)
        .join(" and ");
      boundaries.push({
        paragraphIndex: d.paragraphIndex + 1,
        condition: currentFullCondition(),
      });
    } else if (d.kind === "endif") {
      if (stack.length > 0) {
        stack.pop();
      }
      boundaries.push({
        paragraphIndex: d.paragraphIndex + 1,
        condition: currentFullCondition(),
      });
    }
    // each/endeach: no condition change
  }

  boundaries.sort((a, b) => a.paragraphIndex - b.paragraphIndex);

  const map = new Map<number, string>();

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    if (!boundary) {
      continue;
    }
    const nextIdx =
      i + 1 < boundaries.length
        ? (boundaries[i + 1]?.paragraphIndex ?? paragraphCount)
        : paragraphCount;

    if (boundary.condition === undefined) {
      continue;
    }

    for (let idx = boundary.paragraphIndex; idx < nextIdx; idx++) {
      map.set(idx, boundary.condition);
    }
  }

  return map;
};

type AnalysisResult = {
  fields: FieldAccumulator;
  errors: TemplateStructureError[];
  placeholderCounts: Map<string, number>;
  fieldConditions: Map<string, string | null>;
  warnings: TemplateWarning[];
  conditionPaths: Set<string>;
};

type ContainerStructureOptions = {
  body: slimdom.Element;
  conditionPaths: Set<string>;
  errors: TemplateStructureError[];
  fields: FieldAccumulator;
  warnings: TemplateWarning[];
};

const collectContainerStructure = ({
  body,
  conditionPaths,
  errors,
  fields,
  warnings,
}: ContainerStructureOptions) => {
  const paragraphs = body.getElementsByTagNameNS(W_NS, "p");
  const directives = scanBlockDirectives(body);
  const { blocks, errors: parseErrors } = parseBlockTree(directives);
  errors.push(...parseErrors);
  const arrayScopes = new Map<number, readonly RowScope[]>();
  const activeArrays: RowScope[] = [];
  const directiveByParagraph = new Map(
    directives.map((directive) => [directive.paragraphIndex, directive]),
  );
  for (let i = 0; i < paragraphs.length; i++) {
    const directive = directiveByParagraph.get(i);
    if (directive?.kind === "endeach") {
      activeArrays.pop();
    }
    if (directive?.kind === "if" || directive?.kind === "elseif") {
      registerConditionFields({
        condition: directive.expression,
        conditionPaths,
        fields,
        rowPaths: rowScopePaths(activeArrays),
      });
    }
    if (directive?.kind === "each") {
      const scopedPath = qualifyRowScopedPath(
        directive.expression,
        rowScopePaths(activeArrays),
      );
      registerField(fields, scopedPath, "array");
      activeArrays.push({
        declaredPath: directive.expression,
        scopedPath,
      });
    }
    arrayScopes.set(i, [...activeArrays]);

    const paragraph = paragraphs[i];
    if (paragraph) {
      warnings.push(
        ...collectParagraphWarnings({
          loops: activeArrays,
          paragraphIndex: i,
          text: paragraphText(paragraph),
        }),
      );
    }
  }
  const directiveIndices = new Set<number>();
  for (const d of directives) {
    directiveIndices.add(d.paragraphIndex);
  }

  return {
    arrayScopes,
    blocks,
    conditionMap: buildConditionMapFromRanges(directives, paragraphs.length),
    directiveIndices,
    paragraphs,
  };
};

const collectLoopItemFields = ({
  arrayScopes,
  blocks,
  directiveIndices,
  fields,
  paragraphs,
}: ReturnType<typeof collectContainerStructure> & {
  fields: FieldAccumulator;
}): void => {
  for (const block of blocks) {
    if (block.kind !== "each") {
      continue;
    }
    const blockScope = requireRowScopes(arrayScopes, block.contentStart - 1).at(
      -1,
    );
    if (blockScope === undefined) {
      panic(`Missing loop scope for block ${block.arrayPath}`);
    }
    const arrayPath = blockScope.scopedPath;
    registerField(fields, arrayPath, "array");

    const entry = fields.get(arrayPath);
    for (let i = block.contentStart; i < block.contentEnd; i++) {
      const para = paragraphs[i];
      if (!para) {
        break;
      }
      if (directiveIndices.has(i)) {
        continue;
      }

      const text = paragraphText(para);
      const prefix = `${block.arrayPath}.`;
      for (const match of text.matchAll(PLACEHOLDER_RE)) {
        const name = match.groups?.["name"];
        if (name?.startsWith(prefix)) {
          entry?.itemPaths.add(name.slice(prefix.length));
        }
      }
    }
  }
};

const collectParagraphPlaceholders = ({
  arrayScopes,
  conditionMap,
  conditionPaths,
  directiveIndices,
  errors,
  fieldConditions,
  fields,
  paragraphs,
  placeholderCounts,
}: ReturnType<typeof collectContainerStructure> & AnalysisResult): void => {
  for (let i = 0; i < paragraphs.length; i++) {
    if (directiveIndices.has(i)) {
      continue;
    }

    const para = paragraphs[i];
    if (!para) {
      continue;
    }
    const text = paragraphText(para);
    const paraCondition = conditionMap.get(i);
    const inlineBranchConditions: {
      condition: string | undefined;
      end: number;
      start: number;
    }[] = [];
    const inlineLoopScopes: {
      declaredPath: string;
      end: number;
      scopedPath: string;
      start: number;
    }[] = [];

    const inline = parseInlineConditions(text);
    if (!inline.ok) {
      errors.push({
        message: inline.message,
        paragraphIndex: i,
        directive: inline.directive,
      });
    } else {
      for (const group of inline.groups) {
        if (group.kind === "each") {
          const scopedPath = qualifyRowScopedPath(
            group.arrayPath,
            rowScopePaths(requireRowScopes(arrayScopes, i)),
          );
          registerField(fields, scopedPath, "array");
          inlineLoopScopes.push({
            declaredPath: group.arrayPath,
            end: group.contentEnd,
            scopedPath,
            start: group.contentStart,
          });
          const entry = fields.get(scopedPath);
          const content = text.slice(group.contentStart, group.contentEnd);
          const prefix = `${group.arrayPath}.`;
          for (const match of content.matchAll(PLACEHOLDER_RE)) {
            const name = match.groups?.["name"];
            if (name?.startsWith(prefix)) {
              entry?.itemPaths.add(name.slice(prefix.length));
            }
          }
          continue;
        }

        const priorConditions: string[] = [];
        for (const branch of group.branches) {
          registerConditionFields({
            condition: branch.condition,
            conditionPaths,
            fields,
            rowPaths: rowScopePaths(requireRowScopes(arrayScopes, i)),
          });
          const branchCondition =
            branch.condition === ""
              ? priorConditions.map(negateExpr).join(" and ")
              : [
                  ...priorConditions.map(negateExpr),
                  wrapConjunctionPart(branch.condition),
                ].join(" and ");
          inlineBranchConditions.push({
            condition: combineConditions(
              paraCondition,
              branchCondition || undefined,
            ),
            end: branch.contentEnd,
            start: branch.contentStart,
          });
          if (branch.condition !== "") {
            priorConditions.push(branch.condition);
          }
        }
      }
    }

    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const declaredName = match.groups?.["name"];
      if (!declaredName) {
        continue;
      }
      // @-prefixed markers (@clause:, @num:, @ref:) are resolved at fill time,
      // not user-entered fields — keep them out of the discovered schema.
      if (declaredName.startsWith("@")) {
        continue;
      }
      const loopScope = inlineLoopScopes.find(
        ({ end, start }) => start <= match.index && match.index < end,
      );
      const declaredLoopPrefix = `${loopScope?.declaredPath ?? ""}.`;
      const inlineScopedName =
        loopScope !== undefined && declaredName.startsWith(declaredLoopPrefix)
          ? `${loopScope.scopedPath}.${declaredName.slice(declaredLoopPrefix.length)}`
          : declaredName;
      const scopedArrayPaths = requireRowScopes(arrayScopes, i);
      const name = qualifyRowScopedPlaceholder(
        inlineScopedName,
        scopedArrayPaths,
      );
      placeholderCounts.set(name, (placeholderCounts.get(name) ?? 0) + 1);

      const inlineCondition = inlineBranchConditions.find(
        ({ end, start }) => start <= match.index && match.index < end,
      )?.condition;
      recordFieldCondition(
        fieldConditions,
        name,
        inlineCondition ?? paraCondition,
      );

      // Infer field kind from path structure
      if (name.includes(".")) {
        // Could be an object field (company.name) or an
        // array item field (sellers.name). Check if the
        // root is already registered as an array.
        const root = name.split(".")[0];
        if (!root) {
          continue;
        }
        const rootEntry = fields.get(root);
        if (!rootEntry || rootEntry.kind !== "array") {
          // Register the root as an object
          registerField(fields, root, "object");
        }
      }
      // Register the full path as string
      registerField(fields, name, "string");

      if (scopedArrayPaths.length > 0) {
        for (const { scopedPath: arrayPath } of scopedArrayPaths) {
          const prefix = `${arrayPath}.`;
          if (name.startsWith(prefix)) {
            fields.get(arrayPath)?.itemPaths.add(name.slice(prefix.length));
          }
        }
      }
    }
  }
};

/**
 * Analyze a container element (w:body, w:hdr, or w:ftr) to
 * extract field information from its paragraphs.
 */
const analyzeContainer = (body: slimdom.Element): AnalysisResult => {
  const fields: FieldAccumulator = new Map();
  const placeholderCounts = new Map<string, number>();
  const errors: TemplateStructureError[] = [];
  const fieldConditions = new Map<string, string | null>();
  const warnings: TemplateWarning[] = [];
  const conditionPaths = new Set<string>();
  const structure = collectContainerStructure({
    body,
    conditionPaths,
    errors,
    fields,
    warnings,
  });
  collectLoopItemFields({ ...structure, fields });
  collectParagraphPlaceholders({
    ...structure,
    conditionPaths,
    errors,
    fieldConditions,
    fields,
    placeholderCounts,
    warnings,
  });

  return {
    fields,
    errors,
    placeholderCounts,
    fieldConditions,
    warnings,
    conditionPaths,
  };
};

// ── Merge helpers ────────────────────────────────────────

/**
 * Merge fields from a secondary container (header/footer)
 * into the primary accumulators. Deduplicates by path.
 */
const mergeAnalysis = (
  primary: AnalysisResult,
  secondary: AnalysisResult,
): void => {
  for (const [path, info] of secondary.fields) {
    registerField(primary.fields, path, info.kind);
    const entry = primary.fields.get(path);
    if (entry) {
      // Merge item paths for array fields
      for (const ip of info.itemPaths) {
        entry.itemPaths.add(ip);
      }
      // Add secondary count (minus the 1 already added by
      // registerField)
      entry.count += info.count - 1;
    }
  }

  primary.errors.push(...secondary.errors);
  primary.warnings.push(...secondary.warnings);
  for (const path of secondary.conditionPaths) {
    primary.conditionPaths.add(path);
  }

  for (const [name, count] of secondary.placeholderCounts) {
    primary.placeholderCounts.set(
      name,
      (primary.placeholderCounts.get(name) ?? 0) + count,
    );
  }

  // Merge field conditions: if a field appears outside
  // a conditional in either container, it's always visible
  for (const [name, cond] of secondary.fieldConditions) {
    const existing = primary.fieldConditions.get(name);
    if (existing === null || cond === null) {
      primary.fieldConditions.set(name, null);
    } else if (existing === undefined) {
      primary.fieldConditions.set(name, cond);
    } else if (existing !== cond) {
      primary.fieldConditions.set(name, null);
    }
  }
};

/**
 * Scan header/footer XML entries in the ZIP and analyze
 * each one with the same logic used for document.xml.
 */
const analyzeHeadersAndFooters = async (
  zip: JSZip,
): Promise<AnalysisResult> => {
  const result: AnalysisResult = {
    fields: new Map(),
    errors: [],
    placeholderCounts: new Map(),
    fieldConditions: new Map(),
    warnings: [],
    conditionPaths: new Set(),
  };

  // Sort entries alphabetically to match the order used by
  // extractText (which assigns globally sequential indices).
  const entries = templateContentPartPaths(Object.keys(zip.files)).filter(
    (path) => path !== MAIN_DOCUMENT_PART_PATH,
  );

  // Track running paragraph counts per source so error indices
  // are relative to the combined section, not individual files.
  let headerParaCount = 0;
  let footerParaCount = 0;

  for (const path of entries) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }

    const xml = await entry.async("string");
    const doc = slimdom.parseXmlDocument(xml);

    // Headers use w:hdr, footers use w:ftr as root element
    const hdr = doc.getElementsByTagNameNS(W_NS, "hdr").at(0);
    const container = hdr ?? doc.getElementsByTagNameNS(W_NS, "ftr").at(0);

    if (!container) {
      continue;
    }

    const source = hdr ? "header" : "footer";
    const offset = source === "header" ? headerParaCount : footerParaCount;
    const analysis = analyzeContainer(container);

    // Tag errors with their source and offset indices to
    // match the global ordering in extractText.
    for (const err of analysis.errors) {
      err.source = source;
      err.paragraphIndex += offset;
    }

    const paraCount = container.getElementsByTagNameNS(W_NS, "p").length;
    if (source === "header") {
      headerParaCount += paraCount;
    } else {
      footerParaCount += paraCount;
    }

    mergeAnalysis(result, analysis);
  }

  return result;
};

// ── Public API ───────────────────────────────────────────

export const discoverTemplate = async (
  docxBuffer: Buffer,
): Promise<DiscoveredTemplate> => {
  const zip = await JSZip.loadAsync(docxBuffer);
  const emptyResult: DiscoveredTemplate = {
    placeholders: [],
    fields: [],
    structureErrors: [],
    warnings: [],
    conditionPaths: [],
  };

  const docEntry = zip.file(MAIN_DOCUMENT_PART_PATH);
  if (!docEntry) {
    return emptyResult;
  }

  const xml = await docEntry.async("string");
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);

  if (!body) {
    return emptyResult;
  }

  const primary = analyzeContainer(body);

  // Tag body errors with their source
  for (const err of primary.errors) {
    err.source = "body";
  }

  // Scan headers and footers for additional fields
  const hfAnalysis = await analyzeHeadersAndFooters(zip);
  mergeAnalysis(primary, hfAnalysis);

  const { fields, errors, placeholderCounts, fieldConditions } = primary;
  const conditionPaths = [...primary.conditionPaths].toSorted(compareCodeUnit);

  // Build DiscoveredPlaceholder[] (backward-compat)
  const placeholders: DiscoveredPlaceholder[] = [...placeholderCounts.entries()]
    // placeholder name is a template merge-field path (e.g. "client.name"),
    // not display text
    .toSorted(([a], [b]) => compareCodeUnit(a, b))
    .map(([name, count]) => ({ name, count }));

  // Build DiscoveredField[]
  const discoveredFields: DiscoveredField[] = [];
  const arrayPaths = [...fields]
    .filter(([, info]) => info.kind === "array")
    .map(([path]) => path);
  for (const [path, info] of fields) {
    // Repeated-row descendants are represented relative to their array root.
    // Other dotted fields remain first-class: condition-only paths have no
    // placeholder entry, and filtering them here would erase valid inputs.
    const isRepeatedRowDescendant = arrayPaths.some((arrayPath) =>
      path.startsWith(`${arrayPath}.`),
    );
    if (info.kind !== "array" && isRepeatedRowDescendant) {
      continue;
    }

    const field: DiscoveredField = {
      path,
      kind: info.kind,
      count: info.count,
    };

    // Attach visibleWhen from condition map.
    // `null` means always visible (field appears outside
    // conditionals); `undefined` means not seen as a
    // placeholder (condition-driver booleans); a string
    // is the condition expression.
    const cond = fieldConditions.get(path);
    if (typeof cond === "string") {
      field.visibleWhen = cond;
    }

    if (info.kind === "array" && info.itemPaths.size > 0) {
      field.itemFields = [...info.itemPaths].toSorted().map((p) => ({
        path: p,
        kind: "string" as const,
        count: placeholderCounts.get(`${path}.${p}`) ?? 1,
      }));
    }

    discoveredFields.push(field);
  }

  // Sort fields by path (a template merge-field path, not display text)
  discoveredFields.sort((a, b) => compareCodeUnit(a.path, b.path));

  return {
    placeholders,
    fields: discoveredFields,
    structureErrors: errors,
    warnings: boundTemplateWarnings(primary.warnings),
    conditionPaths,
  };
};

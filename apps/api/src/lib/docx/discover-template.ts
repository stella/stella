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
import {
  parseCondition,
  type ConditionNode,
  type FilterCall,
} from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";

import { parseBlockTree, scanBlockDirectives } from "./block-directives";
import { scanPlaceholders } from "./discover-placeholders";
import {
  arrayFieldFromFilters,
  fieldMetaFromFilters,
  filterChainSignature,
  foldItemCountConstraints,
} from "./field-filters";
import { parseInlineConditions } from "./inline-conditions";
import type { InlineGroup } from "./inline-conditions";
import {
  MAIN_DOCUMENT_PART_PATH,
  paragraphText,
  templateContentPartPaths,
  W_NS,
} from "./ooxml";
import {
  authoredParagraphIndices,
  misplacedRowBlocks,
  normalizeRowBlockMarkers,
} from "./row-block-markers";
import {
  boundTemplateWarnings,
  collectParagraphWarnings,
  rowBlockAcrossRowsWarning,
  type TemplateWarning,
} from "./template-warnings";
import type {
  DiscoveredField,
  DiscoveredPlaceholder,
  DiscoveredTemplate,
  FieldMeta,
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
  rowScopes?: readonly RowScope[];
};

const registerConditionFields = ({
  condition,
  conditionPaths,
  fields,
  rowScopes = [],
}: ConditionFieldOptions): void => {
  const root = parseCondition(condition);
  if (!root) {
    return;
  }
  const rowPaths = rowScopePaths(rowScopes);

  const registerPath = (rawPath: string, kind: "boolean" | "string"): void => {
    // A condition inside a loop reads the item through the loop alias; the
    // manifest speaks the array path, so resolve the alias before registering.
    const path = qualifyRowScopedPlaceholder(rawPath, rowScopes);
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
  /** The loop variable the body addresses items through. */
  alias: string;
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
  for (const { alias, declaredPath, scopedPath } of rowScopes.toReversed()) {
    // The alias is the authored form; the declared path still resolves so a
    // template that reaches for the loop's own path is discovered the same way
    // it fills (`unaliased_item_path` names it as a warning).
    for (const head of [alias, declaredPath]) {
      if (path === head) {
        return scopedPath;
      }
      if (path.startsWith(`${head}.`)) {
        return `${scopedPath}.${path.slice(head.length + 1)}`;
      }
    }
  }
  return path;
};

/**
 * The manifest path of a loop declared inside other loops. A nested loop names
 * its array through the enclosing alias (`{% for i in group.items %}`), so the
 * alias resolves first; a loop that names a bare path inherits the innermost
 * row scope, as it always has.
 */
const qualifyLoopPath = (
  declaredPath: string,
  rowScopes: readonly RowScope[],
): string =>
  qualifyRowScopedPath(
    qualifyRowScopedPlaceholder(declaredPath, rowScopes),
    rowScopePaths(rowScopes),
  );

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
 * - Simple: `isUK` → `not isUK`
 * - Already negated: `not isUK` → `isUK`
 * - Compound: `isUK and hasLicense` → `not (isUK and hasLicense)`
 *
 * Uses parentheses for compound expressions so that
 * `evaluateCondition` treats the negation as applying
 * to the entire sub-expression (De Morgan via grouping).
 */
const NEGATED_ATOM_RE = /^not\s+(?<atom>[\p{L}\p{N}_.-]+)$/u;

const negateExpr = (expr: string): string => {
  const trimmed = expr.trim();
  const negated = NEGATED_ATOM_RE.exec(trimmed);
  if (negated) {
    return negated.groups?.["atom"] ?? trimmed;
  }
  // Compound expression: wrap in parens to negate as a unit
  if (trimmed.includes(" ")) {
    return `not (${trimmed})`;
  }
  return `not ${trimmed}`;
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
 * arbitrary nesting and elif/else compound negation.
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
    } else if (d.kind === "elif") {
      const frame = stack.at(-1);
      if (!frame) {
        continue;
      }
      // Wrap the elif expression in parens if it
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
    // for/endfor: no condition change
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

/**
 * One path's field configuration as the document declares it: the filter chain
 * of the occurrence that carries it, and the paragraph it sits in so a
 * disagreement between two occurrences can name both.
 */
type DocumentFieldDeclaration = {
  filters: readonly FilterCall[];
  signature: string;
  paragraphIndex: number;
  /** A loop path's filters configure the repeat, not a value, so the two are
   *  read by different halves of the catalogue. */
  scope: "value" | "array";
};

type AnalysisResult = {
  fields: FieldAccumulator;
  errors: TemplateStructureError[];
  placeholderCounts: Map<string, number>;
  fieldConditions: Map<string, string | null>;
  warnings: TemplateWarning[];
  conditionPaths: Set<string>;
  documentFilters: Map<string, DocumentFieldDeclaration>;
  /** Alias to the array paths it was bound to. More than one path means the
   *  document uses the name for two different loops, so it names nothing. */
  loopAliases: Map<string, Set<string>>;
};

const recordLoopAlias = (
  aliases: Map<string, Set<string>>,
  alias: string,
  path: string,
): void => {
  if (alias === path) {
    return;
  }
  const paths = aliases.get(alias) ?? new Set<string>();
  paths.add(path);
  aliases.set(alias, paths);
};

/**
 * Record one marker's filter chain against its path. Filters may sit on any
 * ONE occurrence of a path — repeating the identical chain is fine, since it
 * says the same thing — but two occurrences that configure the same field
 * differently have no resolution the author would recognize, so both
 * paragraphs are named and neither wins.
 */
type RecordDeclarationOptions = {
  declarations: Map<string, DocumentFieldDeclaration>;
  errors: TemplateStructureError[];
  filters: readonly FilterCall[];
  paragraphIndex: number;
  path: string;
  scope?: "value" | "array";
};

const recordFieldDeclaration = ({
  declarations,
  errors,
  filters,
  paragraphIndex,
  path,
  scope = "value",
}: RecordDeclarationOptions): void => {
  if (filters.length === 0) {
    return;
  }
  const signature = filterChainSignature(filters);
  const existing = declarations.get(path);
  if (existing === undefined) {
    declarations.set(path, { filters, signature, paragraphIndex, scope });
    return;
  }
  if (existing.signature === signature) {
    return;
  }
  errors.push({
    message:
      `"${path}" is configured twice with different filters: paragraph ` +
      `${existing.paragraphIndex + 1} says ${existing.signature} and ` +
      `paragraph ${paragraphIndex + 1} says ${signature}. Keep the filters on ` +
      "one occurrence and write the others as a plain {{ " +
      `${path} }} marker.`,
    paragraphIndex,
    directive: `{{ ${path} | … }}`,
  });
};

type ContainerStructureOptions = {
  body: slimdom.Element;
  conditionPaths: Set<string>;
  documentFilters: Map<string, DocumentFieldDeclaration>;
  errors: TemplateStructureError[];
  fields: FieldAccumulator;
  loopAliases: Map<string, Set<string>>;
  warnings: TemplateWarning[];
};

const collectContainerStructure = ({
  body,
  conditionPaths,
  documentFilters,
  errors,
  fields,
  loopAliases,
  warnings,
}: ContainerStructureOptions) => {
  const paragraphs = body.getElementsByTagNameNS(W_NS, "p");
  // Positions to report. Everything below indexes `paragraphs`, which carries
  // the marker paragraphs normalization hoisted out of a table row's cells;
  // a diagnostic has to name the paragraph the author can count to instead.
  const authoredIndices = authoredParagraphIndices(paragraphs);
  const directives = scanBlockDirectives(body);
  const { blocks, errors: parseErrors } = parseBlockTree(directives);
  for (const error of parseErrors) {
    errors.push({
      ...error,
      paragraphIndex:
        authoredIndices[error.paragraphIndex] ?? error.paragraphIndex,
    });
  }
  const arrayScopes = new Map<number, readonly RowScope[]>();
  const activeArrays: RowScope[] = [];
  const directiveByParagraph = new Map(
    directives.map((directive) => [directive.paragraphIndex, directive]),
  );
  for (let i = 0; i < paragraphs.length; i++) {
    const directive = directiveByParagraph.get(i);
    if (directive?.kind === "endfor") {
      activeArrays.pop();
    }
    if (directive?.kind === "if" || directive?.kind === "elif") {
      registerConditionFields({
        condition: directive.expression,
        conditionPaths,
        fields,
        rowScopes: [...activeArrays],
      });
    }
    if (directive?.kind === "for") {
      const scopedPath = qualifyLoopPath(directive.expression, activeArrays);
      registerField(fields, scopedPath, "array");
      const alias = directive.alias ?? directive.expression;
      recordLoopAlias(loopAliases, alias, scopedPath);
      recordFieldDeclaration({
        declarations: documentFilters,
        errors,
        filters: arrayOrEmpty(directive.filters),
        paragraphIndex: authoredIndices[i] ?? i,
        path: scopedPath,
        scope: "array",
      });
      activeArrays.push({
        alias,
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
          paragraphIndex: authoredIndices[i] ?? i,
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
    authoredIndices,
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
    if (block.kind !== "for") {
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

      const prefixes = [...new Set([block.alias, block.arrayPath])].map(
        (head) => `${head}.`,
      );
      for (const { name } of scanPlaceholders(paragraphText(para))) {
        const prefix = prefixes.find((candidate) => name.startsWith(candidate));
        if (prefix !== undefined) {
          entry?.itemPaths.add(name.slice(prefix.length));
        }
      }
    }
  }
};

const collectParagraphPlaceholders = ({
  arrayScopes,
  authoredIndices,
  conditionMap,
  conditionPaths,
  directiveIndices,
  documentFilters,
  errors,
  fieldConditions,
  fields,
  loopAliases,
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
      alias: string;
      declaredPath: string;
      end: number;
      scopedPath: string;
      start: number;
    }[] = [];

    const inline = parseInlineConditions(text);
    if (!inline.ok) {
      errors.push({
        message: inline.message,
        paragraphIndex: authoredIndices[i] ?? i,
        directive: inline.directive,
      });
    } else {
      // Inline blocks nest, and the parser hands back one level at a time:
      // applying an outer group leaves its inner markers in the text, where
      // the next pass reads them as top-level. Discovery descends the same
      // way, or a nested loop's array is never registered and the items its
      // body writes look like fields of their own.
      const visitInlineGroups = (
        groups: readonly InlineGroup[],
        span: string,
        offset: number,
      ): void => {
        for (const group of groups) {
          if (group.kind === "for") {
            const scopedPath = qualifyLoopPath(group.arrayPath, [
              ...requireRowScopes(arrayScopes, i),
              ...inlineLoopScopes,
            ]);
            registerField(fields, scopedPath, "array");
            recordLoopAlias(loopAliases, group.alias, scopedPath);
            recordFieldDeclaration({
              declarations: documentFilters,
              errors,
              filters: group.filters,
              paragraphIndex: authoredIndices[i] ?? i,
              path: scopedPath,
              scope: "array",
            });
            inlineLoopScopes.push({
              alias: group.alias,
              declaredPath: group.arrayPath,
              end: offset + group.contentEnd,
              scopedPath,
              start: offset + group.contentStart,
            });
            const entry = fields.get(scopedPath);
            const content = span.slice(group.contentStart, group.contentEnd);
            const prefixes = [...new Set([group.alias, group.arrayPath])].map(
              (head) => `${head}.`,
            );
            for (const { name } of scanPlaceholders(content)) {
              const prefix = prefixes.find((candidate) =>
                name.startsWith(candidate),
              );
              if (prefix !== undefined) {
                entry?.itemPaths.add(name.slice(prefix.length));
              }
            }
            const nested = parseInlineConditions(content);
            // The span is balanced by construction: the outer parse already
            // reported anything that was not.
            if (nested.ok) {
              visitInlineGroups(
                nested.groups,
                content,
                offset + group.contentStart,
              );
            }
            continue;
          }

          const priorConditions: string[] = [];
          for (const branch of group.branches) {
            registerConditionFields({
              condition: branch.condition,
              conditionPaths,
              fields,
              rowScopes: [
                ...requireRowScopes(arrayScopes, i),
                ...inlineLoopScopes.map(
                  ({ alias, declaredPath, scopedPath }) => ({
                    alias,
                    declaredPath,
                    scopedPath,
                  }),
                ),
              ],
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
              end: offset + branch.contentEnd,
              start: offset + branch.contentStart,
            });
            if (branch.condition !== "") {
              priorConditions.push(branch.condition);
            }
            const nested = parseInlineConditions(
              span.slice(branch.contentStart, branch.contentEnd),
            );
            if (nested.ok) {
              visitInlineGroups(
                nested.groups,
                span.slice(branch.contentStart, branch.contentEnd),
                offset + branch.contentStart,
              );
            }
          }
        }
      };
      visitInlineGroups(inline.groups, text, 0);
    }

    for (const {
      filters,
      name: declaredName,
      start: markerStart,
    } of scanPlaceholders(text)) {
      // Every inline loop whose body holds this marker, outermost first, so
      // the innermost alias resolves the name and each enclosing array still
      // learns the item path it repeats.
      const enclosingLoops = inlineLoopScopes.filter(
        ({ end, start }) => start <= markerStart && markerStart < end,
      );
      const inlineScopedName = qualifyRowScopedPlaceholder(
        declaredName,
        enclosingLoops,
      );
      const scopedArrayPaths = requireRowScopes(arrayScopes, i);
      const name = qualifyRowScopedPlaceholder(
        inlineScopedName,
        scopedArrayPaths,
      );
      placeholderCounts.set(name, (placeholderCounts.get(name) ?? 0) + 1);
      recordFieldDeclaration({
        declarations: documentFilters,
        errors,
        filters,
        paragraphIndex: authoredIndices[i] ?? i,
        path: name,
      });

      const inlineCondition = inlineBranchConditions.find(
        ({ end, start }) => start <= markerStart && markerStart < end,
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

      for (const { scopedPath: arrayPath } of [
        ...scopedArrayPaths,
        ...enclosingLoops,
      ]) {
        const prefix = `${arrayPath}.`;
        if (name.startsWith(prefix)) {
          fields.get(arrayPath)?.itemPaths.add(name.slice(prefix.length));
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
  // Same rewrite the fill pipeline applies, so a row-form loop is discovered
  // with its item paths and warns exactly as the own-paragraph form does.
  normalizeRowBlockMarkers(body);

  const fields: FieldAccumulator = new Map();
  const placeholderCounts = new Map<string, number>();
  const errors: TemplateStructureError[] = [];
  const fieldConditions = new Map<string, string | null>();
  // Read after the row form is normalized away, so only the pairs that could
  // not be one are left to name.
  const warnings: TemplateWarning[] = misplacedRowBlocks(body).map(
    rowBlockAcrossRowsWarning,
  );
  const conditionPaths = new Set<string>();
  const documentFilters = new Map<string, DocumentFieldDeclaration>();
  const loopAliases = new Map<string, Set<string>>();
  const structure = collectContainerStructure({
    body,
    conditionPaths,
    documentFilters,
    errors,
    fields,
    loopAliases,
    warnings,
  });
  collectLoopItemFields({ ...structure, fields });
  collectParagraphPlaceholders({
    ...structure,
    conditionPaths,
    documentFilters,
    errors,
    fieldConditions,
    fields,
    loopAliases,
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
    documentFilters,
    loopAliases,
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
  for (const [alias, paths] of secondary.loopAliases) {
    for (const path of paths) {
      recordLoopAlias(primary.loopAliases, alias, path);
    }
  }
  for (const [path, declaration] of secondary.documentFilters) {
    recordFieldDeclaration({
      declarations: primary.documentFilters,
      errors: primary.errors,
      filters: declaration.filters,
      paragraphIndex: declaration.paragraphIndex,
      path,
      scope: declaration.scope,
    });
  }
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
    documentFilters: new Map(),
    loopAliases: new Map(),
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
    // Count before analysis: normalizing a row-form marker adds a paragraph of
    // its own, and the running offset must keep counting the authored file.
    const paraCount = container.getElementsByTagNameNS(W_NS, "p").length;
    const analysis = analyzeContainer(container);

    // Tag errors with their source and offset indices to
    // match the global ordering in extractText.
    for (const err of analysis.errors) {
      err.source = source;
      err.paragraphIndex += offset;
    }

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
    documentFields: [],
    loopAliases: [],
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
    documentFields: documentLayerFields({
      arrayPaths: new Set(arrayPaths),
      declarations: primary.documentFilters,
      errors,
    }),
    loopAliases: [...primary.loopAliases]
      .flatMap(([alias, paths]) => {
        const [path] = [...paths];
        // An alias two loops gave different arrays names nothing on its own.
        return paths.size === 1 && path !== undefined ? [{ alias, path }] : [];
      })
      .toSorted((left, right) => compareCodeUnit(left.alias, right.alias)),
  };
};

type DocumentLayerOptions = {
  /** The paths the document loops over, so a count written on one of their
   *  items reaches the repeat it counts. */
  arrayPaths: ReadonlySet<string>;
  declarations: ReadonlyMap<string, DocumentFieldDeclaration>;
  errors: TemplateStructureError[];
};

/**
 * The manifest the markers themselves declare, in path order. A filter the
 * marker cannot act on becomes a structure error against the paragraph it was
 * written in, so the author is told what to change rather than getting a field
 * that silently ignores half its configuration.
 */
const documentLayerFields = ({
  arrayPaths,
  declarations,
  errors,
}: DocumentLayerOptions): FieldMeta[] => {
  const fields: FieldMeta[] = [];
  for (const [path, { filters, paragraphIndex, scope }] of [
    ...declarations,
  ].toSorted(([a], [b]) => compareCodeUnit(a, b))) {
    const { field, issues } =
      scope === "array"
        ? arrayFieldFromFilters(path, filters)
        : fieldMetaFromFilters(path, filters);
    for (const { filter, hint, message } of issues) {
      errors.push({
        message: `${message} ${hint}`,
        paragraphIndex,
        directive: `{{ ${path} | ${filter}(…) }}`,
      });
    }
    if (field) {
      fields.push(field);
    }
  }
  return foldItemCountConstraints(fields, arrayPaths).fields;
};

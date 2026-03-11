/**
 * Extended template discovery: infers the expected data schema
 * from a DOCX template containing placeholders, conditionals,
 * and loops.
 *
 * Returns backward-compatible `DiscoveredPlaceholder[]` plus
 * `DiscoveredField[]` with inferred kinds (string, boolean,
 * array, object) and `structureErrors` for mismatched blocks.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { parseBlockTree, scanBlockDirectives } from "./block-directives";
import { PLACEHOLDER_RE } from "./discover-placeholders";
import { HEADER_FOOTER_RE, paragraphText, W_NS } from "./ooxml";
import type {
  DiscoveredField,
  DiscoveredPlaceholder,
  DiscoveredTemplate,
  TemplateFieldKind,
  TemplateStructureError,
} from "./types";

// ── Condition expression analysis ────────────────────────

/**
 * Extract variable paths referenced in a condition expression.
 * Strips string literals, operators, and keywords.
 */
const CONDITION_TOKEN_RE =
  /"(?:[^"\\]|\\.)*"|==|!=|>=|<=|>|<|!(?!=)|and\b|or\b|([\p{L}\p{N}_.]+)/gu;

const NUMERIC_LITERAL_RE = /^[\d_]+$/;

const COMPARISON_OPS = new Set(["==", "!=", ">=", "<=", ">", "<"]);

// ── Field inference ──────────────────────────────────────

type FieldAccumulator = Map<
  string,
  { kind: TemplateFieldKind; count: number; itemPaths: Set<string> }
>;

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

/**
 * Analyze a container element (w:body, w:hdr, or w:ftr) to
 * extract field information from its paragraphs.
 */
const analyzeContainer = (
  body: slimdom.Element,
): {
  fields: FieldAccumulator;
  errors: TemplateStructureError[];
  placeholderCounts: Map<string, number>;
} => {
  const fields: FieldAccumulator = new Map();
  const placeholderCounts = new Map<string, number>();
  const errors: TemplateStructureError[] = [];

  const paragraphs = body.getElementsByTagNameNS(W_NS, "p");

  // 1. Scan block directives for structural fields
  const directives = scanBlockDirectives(body);
  const { blocks, errors: parseErrors } = parseBlockTree(directives);
  errors.push(...parseErrors);

  // Track which paragraph indices are directives (skip for
  // placeholder scanning)
  const directiveIndices = new Set<number>();
  for (const d of directives) {
    directiveIndices.add(d.paragraphIndex);
  }

  // 2. Analyze blocks for field types
  for (const block of blocks) {
    if (block.kind === "each") {
      registerField(fields, block.arrayPath, "array");

      // Scan content paragraphs for item field references
      const entry = fields.get(block.arrayPath);
      for (let i = block.contentStart; i < block.contentEnd; i++) {
        if (i >= paragraphs.length) {
          break;
        }
        if (directiveIndices.has(i)) {
          continue;
        }

        const text = paragraphText(paragraphs[i]);
        const prefix = `${block.arrayPath}.`;
        for (const match of text.matchAll(PLACEHOLDER_RE)) {
          const name = match[1];
          if (name.startsWith(prefix)) {
            const itemField = name.slice(prefix.length);
            entry?.itemPaths.add(itemField);
          }
        }
      }
    } else {
      // if block — extract condition variables as booleans
      // (or string if used in a comparison)
      for (const branch of block.branches) {
        if (branch.condition === "") {
          continue; // else
        }

        // Group tokens by and/or to check comparisons per
        // sub-expression. Uses the tokenizer (not string split)
        // so `and`/`or` inside string literals are ignored.
        type SubExpr = { paths: string[]; hasComparison: boolean };
        const subExprs: SubExpr[] = [];
        let current: SubExpr = { paths: [], hasComparison: false };
        subExprs.push(current);

        for (const m of branch.condition.matchAll(CONDITION_TOKEN_RE)) {
          const raw = m[0];
          const ident = m[1];

          if (raw === "and" || raw === "or") {
            current = { paths: [], hasComparison: false };
            subExprs.push(current);
          } else if (COMPARISON_OPS.has(raw)) {
            current.hasComparison = true;
          } else if (
            ident &&
            ident !== "true" &&
            ident !== "false" &&
            !NUMERIC_LITERAL_RE.test(ident)
          ) {
            current.paths.push(ident);
          }
        }

        for (const { paths, hasComparison } of subExprs) {
          for (const path of paths) {
            registerField(fields, path, hasComparison ? "string" : "boolean");
          }
        }
      }
    }
  }

  // 3. Scan all non-directive paragraphs for placeholders
  for (let i = 0; i < paragraphs.length; i++) {
    if (directiveIndices.has(i)) {
      continue;
    }

    const text = paragraphText(paragraphs[i]);
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const name = match[1];
      placeholderCounts.set(name, (placeholderCounts.get(name) ?? 0) + 1);

      // Infer field kind from path structure
      if (name.includes(".")) {
        // Could be an object field (company.name) or an
        // array item field (sellers.name). Check if the
        // root is already registered as an array.
        const root = name.split(".")[0];
        const rootEntry = fields.get(root);
        if (!rootEntry || rootEntry.kind !== "array") {
          // Register the root as an object
          registerField(fields, root, "object");
        }
        // Register the full path as string
        registerField(fields, name, "string");
      } else {
        registerField(fields, name, "string");
      }
    }
  }

  return { fields, errors, placeholderCounts };
};

// ── Merge helpers ────────────────────────────────────────

/**
 * Merge fields from a secondary container (header/footer)
 * into the primary accumulators. Deduplicates by path.
 */
const mergeAnalysis = (
  primary: {
    fields: FieldAccumulator;
    errors: TemplateStructureError[];
    placeholderCounts: Map<string, number>;
  },
  secondary: {
    fields: FieldAccumulator;
    errors: TemplateStructureError[];
    placeholderCounts: Map<string, number>;
  },
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

  for (const [name, count] of secondary.placeholderCounts) {
    primary.placeholderCounts.set(
      name,
      (primary.placeholderCounts.get(name) ?? 0) + count,
    );
  }
};

/**
 * Scan header/footer XML entries in the ZIP and analyze
 * each one with the same logic used for document.xml.
 */
const analyzeHeadersAndFooters = async (
  zip: JSZip,
): Promise<{
  fields: FieldAccumulator;
  errors: TemplateStructureError[];
  placeholderCounts: Map<string, number>;
}> => {
  const fields: FieldAccumulator = new Map();
  const errors: TemplateStructureError[] = [];
  const placeholderCounts = new Map<string, number>();
  const result = { fields, errors, placeholderCounts };

  // Sort entries alphabetically to match the order used by
  // extractText (which assigns globally sequential indices).
  const entries = Object.keys(zip.files)
    .filter((path) => HEADER_FOOTER_RE.test(path))
    .toSorted();

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
    const hdr = doc.getElementsByTagNameNS(W_NS, "hdr")[0];
    const container = hdr ?? doc.getElementsByTagNameNS(W_NS, "ftr")[0];

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
  };

  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    return emptyResult;
  }

  const xml = await docEntry.async("string");
  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];

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

  const { fields, errors, placeholderCounts } = primary;

  // Build DiscoveredPlaceholder[] (backward-compat)
  const placeholders: DiscoveredPlaceholder[] = [...placeholderCounts.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));

  // Build DiscoveredField[]
  const discoveredFields: DiscoveredField[] = [];
  for (const [path, info] of fields) {
    // Skip dotted subfields; they'll be nested under their
    // parent array or object
    if (path.includes(".")) {
      continue;
    }

    const field: DiscoveredField = {
      path,
      kind: info.kind,
      count: info.count,
    };

    if (info.kind === "array" && info.itemPaths.size > 0) {
      field.itemFields = [...info.itemPaths].toSorted().map((p) => ({
        path: p,
        kind: "string" as const,
        count: placeholderCounts.get(`${path}.${p}`) ?? 1,
      }));
    }

    discoveredFields.push(field);
  }

  // Sort fields alphabetically
  discoveredFields.sort((a, b) => a.path.localeCompare(b.path));

  return {
    placeholders,
    fields: discoveredFields,
    structureErrors: errors,
  };
};

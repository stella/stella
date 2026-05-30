// Enforce folio's render-pipeline layer boundaries.
//
// Folio's `core/` directory is split into a linear pipeline:
//
//   docx  →  prosemirror  →  layout-bridge  →  layout-engine  →  layout-painter
//
// Every layer consumes the layer to its left. The painter (DOM render) is
// strictly downstream and must not pull upstream concerns — measurement,
// FlowBlock construction, footnote stack constants — by name.
//
// Allowed shared seams (engine sub-modules that are pure: no DOM, no PM):
//   - `layout-engine/types`    — shared data shapes, constants, and pure predicates
//   - `layout-engine/measure`  — pure measurement helpers (canvas / font math)
//
// Every other cross-layer import is forbidden. The matching architecture
// test (`packages/folio/src/core/__tests__/layer-boundaries.test.ts`) walks
// the same import edges with `Bun.Glob` and asserts the same rule, so a
// loosened lint config cannot silently re-introduce the cycle.
//
// Flagged examples:
//   import { measureParagraph } from "../layout-bridge/measuring";
//                                     ^^^ painter -> bridge (forbidden)
//   import { HeaderFooterContent } from "../layout-painter/renderPage";
//                                       ^^^ bridge -> painter (forbidden)
//   import { paginate } from "../layout-engine/paginator";
//                            ^^^ painter -> engine (non-seam path)
//
// Safe examples:
//   import { Page, FOOTNOTE_SEPARATOR_HEIGHT } from "../layout-engine/types";
//   import { measureParagraph } from "../layout-engine/measure";

const PAINTER_PREFIX = "packages/folio/src/core/layout-painter/";
const BRIDGE_PREFIX = "packages/folio/src/core/layout-bridge/";
const ENGINE_PREFIX = "packages/folio/src/core/layout-engine/";

type Layer = "painter" | "bridge" | "engine";

const matchesLayerPrefix = (normalizedPath: string, prefix: string): boolean =>
  normalizedPath.includes(prefix) ||
  normalizedPath.endsWith(prefix.slice(0, -1));

const layerOf = (absolutePath: string): Layer | null => {
  const normalized = absolutePath.replaceAll("\\", "/");
  if (matchesLayerPrefix(normalized, PAINTER_PREFIX)) {
    return "painter";
  }
  if (matchesLayerPrefix(normalized, BRIDGE_PREFIX)) {
    return "bridge";
  }
  if (matchesLayerPrefix(normalized, ENGINE_PREFIX)) {
    return "engine";
  }
  return null;
};

// Resolve a relative or "../" import specifier against the importing file's
// directory. Returns a normalized path string we can prefix-match against the
// layer constants. Non-relative specifiers (bare packages, "@stll/...") are
// out of scope for this rule and return null.
const resolveCoreTarget = (
  importerPath: string,
  specifier: string,
): string | null => {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const importerDir = importerPath
    .replaceAll("\\", "/")
    .split("/")
    .slice(0, -1);
  const parts = specifier.split("/");
  const stack = [...importerDir];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
};

// Strip the file extension and trailing `/index` so we can compare path
// suffixes against the allowed-seam list.
const stripExtAndIndex = (resolved: string): string => {
  let value = resolved;
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    if (value.endsWith(ext)) {
      value = value.slice(0, -ext.length);
      break;
    }
  }
  if (value.endsWith("/index")) {
    value = value.slice(0, -"/index".length);
  }
  return value;
};

const ALLOWED_PAINTER_TO_ENGINE_SUFFIXES = [
  "layout-engine/types",
  "layout-engine/measure",
];

const isAllowedPainterToEngine = (resolvedTarget: string): boolean => {
  const stripped = stripExtAndIndex(resolvedTarget);
  for (const suffix of ALLOWED_PAINTER_TO_ENGINE_SUFFIXES) {
    if (stripped.endsWith(`/${suffix}`) || stripped.endsWith(suffix)) {
      return true;
    }
    if (stripped.includes(`/${suffix}/`) || stripped.startsWith(`${suffix}/`)) {
      return true;
    }
  }
  return false;
};

type AstNode = Record<string, unknown> & { type: string };

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (descriptor: {
    node: unknown;
    messageId:
      | "painterToBridge"
      | "painterToEngineNonSeam"
      | "bridgeToPainter"
      | "engineToPainter"
      | "engineToBridge";
  }) => void;
};

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof (value as { type: unknown }).type === "string";

// Pull the import specifier (the string literal after `from`) from an
// ImportDeclaration / ExportNamedDeclaration / ExportAllDeclaration node.
// Returns null when the node has no `source` (e.g. `export const x = 1`).
const importSpecifierOf = (node: AstNode): string | null => {
  const source = node.source;
  if (!isAstNode(source)) {
    return null;
  }
  const value = source.value;
  return typeof value === "string" ? value : null;
};

const filenameOf = (context: RuleContext): string => {
  if (typeof context.getFilename === "function") {
    return context.getFilename();
  }
  return context.filename ?? "";
};

const checkEdge = (context: RuleContext, importNode: AstNode): void => {
  const specifier = importSpecifierOf(importNode);
  if (specifier === null) {
    return;
  }
  const importerPath = filenameOf(context);
  if (importerPath === "") {
    return;
  }
  const importerLayer = layerOf(importerPath);
  if (importerLayer === null) {
    return;
  }

  const resolved = resolveCoreTarget(importerPath, specifier);
  if (resolved === null) {
    return;
  }
  const targetLayer = layerOf(resolved);
  if (targetLayer === null || targetLayer === importerLayer) {
    return;
  }

  if (importerLayer === "painter" && targetLayer === "bridge") {
    context.report({ node: importNode, messageId: "painterToBridge" });
    return;
  }
  if (importerLayer === "painter" && targetLayer === "engine") {
    if (!isAllowedPainterToEngine(resolved)) {
      context.report({
        node: importNode,
        messageId: "painterToEngineNonSeam",
      });
    }
    return;
  }
  if (importerLayer === "bridge" && targetLayer === "painter") {
    context.report({ node: importNode, messageId: "bridgeToPainter" });
    return;
  }
  if (importerLayer === "engine" && targetLayer === "painter") {
    context.report({ node: importNode, messageId: "engineToPainter" });
    return;
  }
  if (importerLayer === "engine" && targetLayer === "bridge") {
    context.report({ node: importNode, messageId: "engineToBridge" });
  }
};

export default {
  meta: { name: "folio-layer-boundaries" },
  rules: {
    "no-upstream-import": {
      meta: {
        type: "problem",
        messages: {
          painterToBridge:
            "layout-painter must not import from layout-bridge. The painter " +
            "is the downstream render layer; move shared types or constants " +
            "into layout-engine/types, or move shared measurement helpers " +
            "into layout-engine/measure.",
          painterToEngineNonSeam:
            "layout-painter may only import from layout-engine via " +
            "layout-engine/types or layout-engine/measure. Engine internals " +
            "such as paginator, section-breaks, keep-together, and textBoxFlow " +
            "must not be reached from the painter; expose what you need " +
            "through layout-engine/types instead.",
          bridgeToPainter:
            "layout-bridge must not import from layout-painter. Move the " +
            "shared symbol (type, constant, or pure predicate) into " +
            "layout-engine/types so both layers can consume it from the " +
            "common upstream.",
          engineToPainter:
            "layout-engine must not import from layout-painter. The engine " +
            "is upstream of the painter; move the shared symbol into " +
            "layout-engine/types.",
          engineToBridge:
            "layout-engine must not import from layout-bridge. The engine " +
            "is upstream of the bridge; move the shared symbol into " +
            "layout-engine/types and have the bridge consume it from there.",
        },
      },
      create(context: RuleContext) {
        const handle = (node: unknown) => {
          if (isAstNode(node)) {
            checkEdge(context, node);
          }
        };
        return {
          ImportDeclaration: handle,
          ExportNamedDeclaration: handle,
          ExportAllDeclaration: handle,
        };
      },
    },
  },
};

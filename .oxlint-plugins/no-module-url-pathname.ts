// Derive filesystem paths from module URLs with `fileURLToPath`. A module URL
// (`import.meta.url`, `import.meta.resolve(...)`) is a `file:` URL in Bun and
// Node. Its `pathname` keeps percent-encoding (`%20` for a space) and, on
// Windows, a leading slash before the drive letter (`/C:/repo/...`), so it is
// not a native path. Stripping the `file://` prefix from the URL string has the
// same two defects.
//
// Flagged (each a module URL read as a path):
//   new URL("../fixtures", import.meta.url).pathname
//   new URL(import.meta.url).pathname
//   const { pathname } = new URL(".", import.meta.url)
//   const here = new URL(".", import.meta.url); here.pathname
//   new URL("child", here).pathname           (a module URL base)
//   import.meta.url.replace("file://", "")    (also regex `^file:` and
//   import.meta.url.slice(7)                   `"file://".length` offsets)
//   new URL(import.meta.resolve("pkg")).pathname
//
// Accepted:
//   fileURLToPath(new URL("../fixtures", import.meta.url))   (node:url)
//   import.meta.dirname, import.meta.dir, import.meta.filename, import.meta.path
//   new URL("https://example.test/a", import.meta.url).pathname
//   new URL("/a", "https://example.test").pathname
//
// Boundary: syntactic and local. A module URL is followed through bindings
// declared once and never reassigned, and through `.href` / `.toString()`;
// reassigned bindings, function parameters, call results, object fields and
// imports are not followed. A first argument that is a literal absolute URL of
// another scheme ignores its base, so it is not a module URL. Browser bundles,
// where `import.meta.url` is an http URL and `pathname` is a URL path, are out
// of scope in `oxlint.config.ts`.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Context, Ranged, Variable } from "@oxlint/plugins";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isUnshadowedGlobalIdentifier,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const RULE_NAME = "no-module-url-pathname";
const FILE_SCHEME = "file:";
// `"file://".length` and `"file:///".length`.
const FILE_PREFIX_LENGTHS = new Set([7, 8]);
const PREFIX_SLICE_METHODS = new Set(["slice", "substring", "substr"]);
const PREFIX_REPLACE_METHODS = new Set(["replace", "replaceAll"]);
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:/iu;

const PATHNAME_MESSAGE =
  "URL.pathname of a module URL keeps percent-encoding and yields /C:/... on Windows. Use fileURLToPath(...) from node:url, or import.meta.dirname / import.meta.dir for the module's own directory.";
const PREFIX_MESSAGE =
  "Stripping file:// from a module URL keeps percent-encoding and yields /C:/... on Windows. Use fileURLToPath(...) from node:url, or import.meta.dirname / import.meta.dir for the module's own directory.";

const isImportMeta = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "MetaProperty" &&
  getPropertyName(node.meta) === "import" &&
  getPropertyName(node.property) === "meta";

const importMetaMember = (node: AstNode | null): string | null =>
  node?.type === "MemberExpression" && isImportMeta(node.object)
    ? memberPropertyName(node)
    : null;

const callArguments = (node: unknown): readonly unknown[] =>
  isAstNode(node) && Array.isArray(node.arguments) ? node.arguments : [];

const moduleUrlTracker = (context: Context) => {
  const constInitializer = (
    node: AstNode,
    seen: Set<Variable>,
  ): AstNode | null => {
    if (!isIdentifierReference(node)) {
      return null;
    }
    const variable = resolveVariable(context, node);
    if (variable === null || seen.has(variable)) {
      return null;
    }
    seen.add(variable);
    return stableInitializer(variable);
  };

  // A string holding a module's `file:` URL.
  const isModuleUrlString = (
    value: unknown,
    seen = new Set<Variable>(),
  ): boolean => {
    const node = unwrapExpression(value);
    if (node === null) {
      return false;
    }
    if (importMetaMember(node) === "url") {
      return true;
    }
    if (node.type === "MemberExpression") {
      return (
        memberPropertyName(node) === "href" &&
        isModuleUrlObject(node.object, seen)
      );
    }
    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      if (importMetaMember(callee) === "resolve") {
        return true;
      }
      return (
        callee?.type === "MemberExpression" &&
        memberPropertyName(callee) === "toString" &&
        isModuleUrlObject(callee.object, seen)
      );
    }
    const initializer = constInitializer(node, seen);
    return initializer !== null && isModuleUrlString(initializer, seen);
  };

  // A URL object whose value is a module's `file:` URL or resolves against one.
  const isModuleUrlObject = (
    value: unknown,
    seen = new Set<Variable>(),
  ): boolean => {
    const node = unwrapExpression(value);
    if (node === null) {
      return false;
    }
    if (node.type === "NewExpression") {
      if (
        !isIdentifierReference(node.callee) ||
        node.callee.name !== "URL" ||
        !isUnshadowedGlobalIdentifier(context, node.callee)
      ) {
        return false;
      }
      const [input, base] = callArguments(node);
      if (base === undefined) {
        return isModuleUrl(input, seen);
      }
      const literal = staticStringValue(unwrapExpression(input));
      if (
        literal !== null &&
        ABSOLUTE_URL_PATTERN.test(literal) &&
        !literal.toLowerCase().startsWith(FILE_SCHEME)
      ) {
        return false;
      }
      return isModuleUrl(base, seen);
    }
    const initializer = constInitializer(node, seen);
    return initializer !== null && isModuleUrlObject(initializer, seen);
  };

  // Each shape follows bindings on its own, so a binding visited while
  // checking one shape is still followed for the other.
  const isModuleUrl = (value: unknown, seen: ReadonlySet<Variable>): boolean =>
    isModuleUrlString(value, new Set(seen)) ||
    isModuleUrlObject(value, new Set(seen));

  return { isModuleUrlObject, isModuleUrlString };
};

const isFilePrefixPattern = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  const literal = staticStringValue(node);
  if (literal !== null) {
    return literal.toLowerCase().startsWith(FILE_SCHEME);
  }
  const regex = node.type === "Literal" ? node.regex : undefined;
  return (
    typeof regex === "object" &&
    regex !== null &&
    "pattern" in regex &&
    typeof regex.pattern === "string" &&
    regex.pattern.toLowerCase().startsWith(`^${FILE_SCHEME}`)
  );
};

const isFilePrefixLength = (value: unknown): boolean => {
  const node = unwrapExpression(value);
  return (
    node?.type === "Literal" &&
    typeof node.value === "number" &&
    FILE_PREFIX_LENGTHS.has(node.value)
  );
};

const isAssignmentTarget = (node: unknown): boolean => {
  const parent = isAstNode(node) ? node.parent : null;
  return (
    isAstNode(parent) &&
    ((parent.type === "AssignmentExpression" && parent.left === node) ||
      (parent.type === "UpdateExpression" && parent.argument === node))
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          modulePathname: PATHNAME_MESSAGE,
          moduleUrlPrefix: PREFIX_MESSAGE,
        },
      },
      createOnce(context) {
        const { isModuleUrlObject, isModuleUrlString } =
          moduleUrlTracker(context);
        // First-week rollout: only lines this change touched
        // (scripts/guard-rollouts/no-module-url-pathname.json).
        const report = (
          node: Ranged,
          messageId: "modulePathname" | "moduleUrlPrefix",
        ) => {
          if (
            guardEnforcesLine({
              guard: RULE_NAME,
              file: filenameForContext(context),
              line: context.sourceCode.getLocFromIndex(node.range[0]).line,
            })
          ) {
            context.report({ node, messageId });
          }
        };
        return {
          MemberExpression(node) {
            if (
              memberPropertyName(node) === "pathname" &&
              !isAssignmentTarget(node) &&
              isModuleUrlObject(node.object)
            ) {
              report(node, "modulePathname");
            }
          },
          VariableDeclarator(node) {
            const pattern = node.id;
            if (
              pattern.type !== "ObjectPattern" ||
              !isModuleUrlObject(node.init)
            ) {
              return;
            }
            const readsPathname = pattern.properties.some(
              (property) =>
                property.type === "Property" &&
                (property.computed
                  ? staticStringValue(property.key)
                  : getPropertyName(property.key)) === "pathname",
            );
            if (readsPathname) {
              report(node, "modulePathname");
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (callee?.type !== "MemberExpression") {
              return;
            }
            const method = memberPropertyName(callee);
            const [first] = callArguments(node);
            const stripsPrefix =
              (PREFIX_REPLACE_METHODS.has(method ?? "") &&
                isFilePrefixPattern(first)) ||
              (PREFIX_SLICE_METHODS.has(method ?? "") &&
                isFilePrefixLength(first));
            if (stripsPrefix && isModuleUrlString(callee.object)) {
              report(node, "moduleUrlPrefix");
            }
          },
        };
      },
    },
  },
});

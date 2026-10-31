// A long Select option list should use the searchable `@stll/ui/combobox`.
// This rule detects direct lists and statically sized `.map` sources. It also
// resolves exported literal arrays from local and `@/` modules.

import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";
import { panic } from "better-result";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import {
  elementName,
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  resolveVariable,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const SELECT_MODULE = "@stll/ui/select";
const SELECT_THRESHOLD = 30;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const TS_EXTENSION_SUBSTITUTES: Readonly<
  Record<string, readonly string[] | undefined>
> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const ASSET_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".scss",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".md",
  ".txt",
  ".html",
  ".woff",
  ".woff2",
]);

const syntaxPropertyName = (value: unknown): string | null => {
  if (isIdentifier(value)) {
    return value.name;
  }
  if (isStringLiteral(value)) {
    return value.value;
  }
  return null;
};

const children = (node: AstNode): readonly unknown[] => {
  const result: unknown[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }
    if (Array.isArray(value)) {
      result.push(...value);
    } else if (isAstNode(value)) {
      result.push(value);
    }
  }
  return result;
};

const walk = (node: unknown, visit: (node: AstNode) => void): void => {
  if (!isAstNode(node)) {
    return;
  }
  visit(node);
  for (const child of children(node)) {
    walk(child, visit);
  }
};

const descendants = (node: unknown): AstNode[] => {
  if (!isAstNode(node)) {
    return [];
  }
  return [node, ...children(node).flatMap((child) => descendants(child))];
};

/** Exclusive branches never render together; the larger one is what opens. */
const renderedOptionCount = (
  node: unknown,
  isOption: (node: AstNode) => boolean,
): number => {
  if (!isAstNode(node)) {
    return 0;
  }
  if (node.type === "ConditionalExpression") {
    return Math.max(
      renderedOptionCount(node.consequent, isOption),
      renderedOptionCount(node.alternate, isOption),
    );
  }
  return children(node).reduce<number>(
    (count, child) => count + renderedOptionCount(child, isOption),
    isOption(node) ? 1 : 0,
  );
};

/** A list mapped to text, not to elements, adds no options to the select. */
const mapsToElements = (call: AstNode): boolean => {
  const callback = Array.isArray(call.arguments) ? call.arguments.at(0) : null;
  const inline =
    isAstNode(callback) &&
    (callback.type === "ArrowFunctionExpression" ||
      callback.type === "FunctionExpression");
  return (
    !inline ||
    descendants(callback).some((inner) => inner.type === "JSXElement")
  );
};

const staticArrayLength = (node: unknown): number | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
      "ParenthesizedExpression",
    ].includes(node.type)
  ) {
    return staticArrayLength(node.expression);
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.length;
  }
  if (node.type === "Identifier" && typeof node.name === "string") {
    return null;
  }
  return null;
};

const mappedListIdentifier = (node: unknown): AstNode | null => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !isAstNode(node.callee)
  ) {
    return null;
  }
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    !isAstNode(callee.property) ||
    callee.property.name !== "map"
  ) {
    return null;
  }
  return isAstNode(callee.object) &&
    callee.object.type === "Identifier" &&
    typeof callee.object.name === "string"
    ? callee.object
    : null;
};

const isMappedStaticArray = (node: unknown): boolean => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !isAstNode(node.callee)
  ) {
    return false;
  }
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    isAstNode(callee.property) &&
    callee.property.name === "map" &&
    (staticArrayLength(callee.object) ?? 0) > SELECT_THRESHOLD
  );
};

const importedModulePath = (
  specifier: string,
  filename: string,
): string | null => {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.resolve(process.cwd(), "apps/web/src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(filename), specifier);
  } else {
    return null;
  }
  // An imported asset (JSON, styles, images) is not a list source module.
  if (ASSET_EXTENSIONS.has(path.extname(base))) {
    return null;
  }
  const extension = path.extname(base);
  // TypeScript resolves `./helper.js` to `helper.ts`; mirror that substitution.
  const substituted = TS_EXTENSION_SUBSTITUTES[extension];
  const withoutExtension =
    substituted === undefined ? base : base.slice(0, -extension.length);
  const candidates = [
    base,
    ...(substituted ?? []).map(
      (candidate) => `${withoutExtension}${candidate}`,
    ),
    ...SOURCE_EXTENSIONS.map((candidate) => `${base}${candidate}`),
    ...SOURCE_EXTENSIONS.map((candidate) =>
      path.join(base, `index${candidate}`),
    ),
  ];
  // A directory resolves through its index file, never as the module itself.
  // An import this rule cannot resolve is not a list source: skipping it keeps
  // one unusual import from aborting the lint of the whole file.
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
};

const moduleLongListCache = new Map<string, ReadonlySet<string>>();

const variableDeclaration = (node: unknown): AstNode | null =>
  isAstNode(node) && node.type === "VariableDeclaration" ? node : null;

const moduleExportsLongList = (
  filename: string,
  exportedName: string,
): boolean => {
  const cached = moduleLongListCache.get(filename);
  if (cached !== undefined) {
    return cached.has(exportedName);
  }
  const source = readFileSync(filename, "utf-8");
  const parsed = parseSync(filename, source, { range: true });
  if (parsed.errors.length > 0) {
    return panic(`Unable to parse imported list source ${filename}`);
  }
  const { program } = parsed;
  if (!isAstNode(program) || !Array.isArray(program.body)) {
    return panic(`Unable to parse imported list source ${filename}`);
  }
  const longBindings = new Set<string>();
  const exportedBindings = new Map<string, string>();
  for (const statement of program.body) {
    const declaration = variableDeclaration(
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement,
    );
    if (declaration !== null && Array.isArray(declaration.declarations)) {
      for (const item of declaration.declarations) {
        if (!isAstNode(item) || !isIdentifier(item.id)) {
          continue;
        }
        if ((staticArrayLength(item.init) ?? 0) > SELECT_THRESHOLD) {
          longBindings.add(item.id.name);
        }
        if (isIdentifier(item.init) && longBindings.has(item.init.name)) {
          longBindings.add(item.id.name);
        }
        if (statement.type === "ExportNamedDeclaration") {
          exportedBindings.set(item.id.name, item.id.name);
        }
      }
    }
    if (
      statement.type === "ExportNamedDeclaration" &&
      Array.isArray(statement.specifiers)
    ) {
      for (const specifier of statement.specifiers) {
        if (!isAstNode(specifier)) {
          continue;
        }
        const local = syntaxPropertyName(specifier.local);
        const exported = syntaxPropertyName(specifier.exported);
        if (local !== null && exported !== null) {
          exportedBindings.set(exported, local);
        }
      }
    }
  }
  const exportedLongLists = new Set(
    [...exportedBindings]
      .filter(([, local]) => longBindings.has(local))
      .map(([name]) => name),
  );
  moduleLongListCache.set(filename, exportedLongLists);
  return exportedLongLists.has(exportedName);
};

const importLocals = (program: unknown, filename: string): Set<string> => {
  const locals = new Set<string>();
  if (!isAstNode(program) || !Array.isArray(program.body)) {
    return locals;
  }
  for (const statement of program.body) {
    if (
      !isAstNode(statement) ||
      statement.type !== "ImportDeclaration" ||
      !isAstNode(statement.source) ||
      typeof statement.source.value !== "string" ||
      !Array.isArray(statement.specifiers) ||
      statement.importKind === "type"
    ) {
      continue;
    }
    const namedSpecifiers = statement.specifiers.filter(
      (specifier) =>
        isAstNode(specifier) &&
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type",
    );
    if (namedSpecifiers.length === 0) {
      continue;
    }
    const modulePath = importedModulePath(statement.source.value, filename);
    if (modulePath === null) {
      continue;
    }
    for (const specifier of namedSpecifiers) {
      const imported = getImportedName(specifier);
      const local = getImportLocalName(specifier);
      if (
        imported !== null &&
        local !== null &&
        moduleExportsLongList(modulePath, imported)
      ) {
        locals.add(local);
      }
    }
  }
  return locals;
};

const isBoundedSlice = (node: AstNode): boolean => {
  if (
    node.type !== "CallExpression" ||
    !isAstNode(node.callee) ||
    node.callee.type !== "MemberExpression" ||
    !isIdentifier(node.callee.property, "slice") ||
    !Array.isArray(node.arguments)
  ) {
    return false;
  }
  const [start, end] = node.arguments;
  // Negative bounds count from the array's end, so only non-negative literal
  // bounds prove the result is short.
  return (
    isAstNode(start) &&
    start.type === "Literal" &&
    typeof start.value === "number" &&
    start.value >= 0 &&
    isAstNode(end) &&
    end.type === "Literal" &&
    typeof end.value === "number" &&
    end.value >= 0 &&
    end.value - start.value <= SELECT_THRESHOLD
  );
};

const returnedExpressionReferencesLongList = (
  node: unknown,
  context: Parameters<typeof resolveVariable>[0],
  variables: ReadonlySet<Variable>,
): boolean => {
  if (!isAstNode(node) || isBoundedSlice(node)) {
    return false;
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return variable !== null && variables.has(variable);
  }
  // Follow only positions whose value can become the returned list; a long
  // list read in a condition or for its length does not make the result long.
  const follow = (child: unknown) =>
    returnedExpressionReferencesLongList(child, context, variables);
  switch (node.type) {
    case "ConditionalExpression":
      return follow(node.consequent) || follow(node.alternate);
    case "LogicalExpression":
      return follow(node.left) || follow(node.right);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return follow(node.expression);
    case "CallExpression":
      return (
        isAstNode(node.callee) &&
        node.callee.type === "MemberExpression" &&
        follow(node.callee.object)
      );
    case "ArrayExpression":
      return (
        Array.isArray(node.elements) &&
        node.elements.some(
          (element: unknown) =>
            isAstNode(element) &&
            element.type === "SpreadElement" &&
            follow(element.argument),
        )
      );
    default:
      return false;
  }
};

const helperReturnsLongList = (
  body: unknown,
  context: Parameters<typeof resolveVariable>[0],
  variables: ReadonlySet<Variable>,
): boolean => {
  if (!isAstNode(body)) {
    return false;
  }
  if (body.type !== "BlockStatement") {
    return returnedExpressionReferencesLongList(body, context, variables);
  }
  let returnsLongList = false;
  walk(body, (node) => {
    if (
      node.type === "ReturnStatement" &&
      returnedExpressionReferencesLongList(node.argument, context, variables)
    ) {
      returnsLongList = true;
    }
  });
  return returnsLongList;
};

const identifierResolvesTo = (
  context: Parameters<typeof resolveVariable>[0],
  node: unknown,
  variables: ReadonlySet<Variable>,
): boolean => {
  if (!isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  return variable !== null && variables.has(variable);
};

const isMappedHelperCall = (
  context: Parameters<typeof resolveVariable>[0],
  node: AstNode,
  helpers: ReadonlySet<Variable>,
): boolean =>
  isAstNode(node.callee) &&
  node.callee.type === "MemberExpression" &&
  isIdentifier(node.callee.property, "map") &&
  isAstNode(node.callee.object) &&
  node.callee.object.type === "CallExpression" &&
  identifierResolvesTo(context, node.callee.object.callee, helpers);

export default eslintCompatPlugin({
  meta: { name: "searchable-long-select" },
  rules: {
    "searchable-long-select": {
      meta: {
        type: "problem",
        messages: {
          longSelect:
            "This select has more than 30 options. Use a searchable Combobox from '@stll/ui/combobox'.",
        },
      },
      createOnce(context) {
        let selectLocals = new Set<string>();
        let itemLocals = new Set<string>();
        let longListVariables = new Set<Variable>();
        let longListHelpers = new Set<Variable>();
        return {
          Program(program) {
            selectLocals = new Set();
            itemLocals = new Set();
            longListVariables = new Set();
            longListHelpers = new Set();
            if (!isAstNode(program) || !Array.isArray(program.body)) {
              return;
            }
            for (const statement of program.body) {
              if (
                isAstNode(statement) &&
                statement.type === "ImportDeclaration" &&
                isAstNode(statement.source) &&
                statement.source.value === SELECT_MODULE &&
                Array.isArray(statement.specifiers)
              ) {
                for (const specifier of statement.specifiers) {
                  if (getImportedName(specifier) === "Select") {
                    const local = getImportLocalName(specifier);
                    if (local !== null) {
                      selectLocals.add(local);
                    }
                  }
                  if (getImportedName(specifier) === "SelectItem") {
                    const local = getImportLocalName(specifier);
                    if (local !== null) {
                      itemLocals.add(local);
                    }
                  }
                }
              }
            }
            const hasNativeSelect = descendants(program).some(
              (inner) =>
                inner.type === "JSXElement" && elementName(inner) === "select",
            );
            if (selectLocals.size === 0 && !hasNativeSelect) {
              return;
            }
            const importedLongLists = importLocals(
              program,
              filenameForContext(context),
            );
            walk(program, (inner) => {
              if (
                inner.type !== "ImportSpecifier" ||
                !isIdentifierReference(inner.local) ||
                !importedLongLists.has(inner.local.name)
              ) {
                return;
              }
              const variable = resolveVariable(context, inner.local);
              if (variable !== null) {
                longListVariables.add(variable);
              }
            });
            walk(program, (inner) => {
              if (
                inner.type !== "VariableDeclaration" ||
                !Array.isArray(inner.declarations)
              ) {
                return;
              }
              for (const declaration of inner.declarations) {
                if (
                  !isAstNode(declaration) ||
                  !isAstNode(declaration.id) ||
                  declaration.id.type !== "Identifier" ||
                  typeof declaration.id.name !== "string"
                ) {
                  continue;
                }
                const initializer = declaration.init;
                const sourceVariable = isIdentifierReference(initializer)
                  ? resolveVariable(context, initializer)
                  : null;
                if (
                  (staticArrayLength(initializer) ?? 0) > SELECT_THRESHOLD ||
                  (sourceVariable !== null &&
                    longListVariables.has(sourceVariable))
                ) {
                  const variable = isIdentifierReference(declaration.id)
                    ? resolveVariable(context, declaration.id)
                    : null;
                  if (variable !== null) {
                    longListVariables.add(variable);
                  }
                }
              }
            });
            walk(program, (inner) => {
              if (
                inner.type === "FunctionDeclaration" &&
                isAstNode(inner.id) &&
                inner.id.type === "Identifier" &&
                typeof inner.id.name === "string" &&
                helperReturnsLongList(inner.body, context, longListVariables)
              ) {
                const variable = isIdentifierReference(inner.id)
                  ? resolveVariable(context, inner.id)
                  : null;
                if (variable !== null) {
                  longListHelpers.add(variable);
                }
              }
              if (
                inner.type !== "VariableDeclarator" ||
                !isAstNode(inner.id) ||
                inner.id.type !== "Identifier" ||
                typeof inner.id.name !== "string" ||
                !isAstNode(inner.init)
              ) {
                return;
              }
              if (
                (inner.init.type === "ArrowFunctionExpression" ||
                  inner.init.type === "FunctionExpression") &&
                helperReturnsLongList(
                  inner.init.body,
                  context,
                  longListVariables,
                )
              ) {
                const variable = isIdentifierReference(inner.id)
                  ? resolveVariable(context, inner.id)
                  : null;
                if (variable !== null) {
                  longListHelpers.add(variable);
                }
              }
            });
          },
          JSXElement(node) {
            const name = elementName(node);
            const nativeSelect = name === "select";
            if (name === null || (!nativeSelect && !selectLocals.has(name))) {
              return;
            }
            const itemCount = renderedOptionCount(node, (inner) => {
              if (inner.type !== "JSXElement") {
                return false;
              }
              const innerName = elementName(inner);
              return nativeSelect
                ? innerName === "option"
                : itemLocals.has(innerName ?? "");
            });
            const mappedLongList = descendants(node).some(
              (inner) =>
                inner.type === "CallExpression" &&
                mapsToElements(inner) &&
                (identifierResolvesTo(
                  context,
                  mappedListIdentifier(inner),
                  longListVariables,
                ) ||
                  isMappedStaticArray(inner) ||
                  isMappedHelperCall(context, inner, longListHelpers)),
            );
            if (itemCount > SELECT_THRESHOLD || mappedLongList) {
              context.report({ node, messageId: "longSelect" });
            }
          },
        };
      },
    },
  },
});

// A long Select option list should use the searchable `@stll/ui/combobox`.
// This rule detects direct lists and statically sized `.map` sources. It also
// resolves exported literal arrays from local and `@/` modules.

import { eslintCompatPlugin } from "@oxlint/plugins";
import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import {
  elementName,
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const SELECT_MODULE = "@stll/ui/select";
const SELECT_THRESHOLD = 30;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

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

const mappedListName = (node: unknown): string | null => {
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
    ? callee.object.name
    : null;
};

const isMappedHelperCall = (
  node: unknown,
  helperNames: ReadonlySet<string>,
): boolean => {
  if (
    !isAstNode(node) ||
    node.type !== "CallExpression" ||
    !isAstNode(node.callee)
  ) {
    return false;
  }
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    !isAstNode(callee.property) ||
    callee.property.name !== "map" ||
    !isAstNode(callee.object)
  ) {
    return false;
  }
  const source = callee.object;
  return (
    source.type === "CallExpression" &&
    isAstNode(source.callee) &&
    source.callee.type === "Identifier" &&
    typeof source.callee.name === "string" &&
    helperNames.has(source.callee.name)
  );
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
  const hasSourceExtension = SOURCE_EXTENSIONS.some((extension) =>
    base.endsWith(extension),
  );
  const candidates = !hasSourceExtension
    ? [
        ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) =>
          path.join(base, `index${extension}`),
        ),
      ]
    : [base];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved === undefined) {
    return panic(
      `Unable to resolve local imported list source ${specifier} from ${filename}`,
    );
  }
  return resolved;
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
  return (
    isAstNode(start) &&
    start.type === "Literal" &&
    typeof start.value === "number" &&
    isAstNode(end) &&
    end.type === "Literal" &&
    typeof end.value === "number" &&
    end.value - start.value <= SELECT_THRESHOLD
  );
};

const returnedExpressionReferencesLongList = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean => {
  if (!isAstNode(node) || isBoundedSlice(node)) {
    return false;
  }
  if (isIdentifier(node)) {
    return names.has(node.name);
  }
  return children(node).some((child) =>
    returnedExpressionReferencesLongList(child, names),
  );
};

const helperReturnsLongList = (
  body: unknown,
  names: ReadonlySet<string>,
): boolean => {
  if (!isAstNode(body)) {
    return false;
  }
  if (body.type !== "BlockStatement") {
    return returnedExpressionReferencesLongList(body, names);
  }
  let returnsLongList = false;
  walk(body, (node) => {
    if (
      node.type === "ReturnStatement" &&
      returnedExpressionReferencesLongList(node.argument, names)
    ) {
      returnsLongList = true;
    }
  });
  return returnsLongList;
};

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
        let longListLocals = new Set<string>();
        let longListHelpers = new Set<string>();
        return {
          Program(program) {
            selectLocals = new Set();
            itemLocals = new Set();
            longListLocals = new Set();
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
            longListLocals = importLocals(program, filenameForContext(context));
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
                if (
                  (staticArrayLength(initializer) ?? 0) > SELECT_THRESHOLD ||
                  (isAstNode(initializer) &&
                    initializer.type === "Identifier" &&
                    typeof initializer.name === "string" &&
                    longListLocals.has(initializer.name))
                ) {
                  longListLocals.add(declaration.id.name);
                }
              }
            });
            walk(program, (inner) => {
              if (
                inner.type === "FunctionDeclaration" &&
                isAstNode(inner.id) &&
                inner.id.type === "Identifier" &&
                typeof inner.id.name === "string" &&
                helperReturnsLongList(inner.body, longListLocals)
              ) {
                longListHelpers.add(inner.id.name);
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
                helperReturnsLongList(inner.init.body, longListLocals)
              ) {
                longListHelpers.add(inner.id.name);
              }
            });
          },
          JSXElement(node) {
            const name = elementName(node);
            const nativeSelect = name === "select";
            if (name === null || (!nativeSelect && !selectLocals.has(name))) {
              return;
            }
            const nestedNodes = descendants(node);
            const itemCount = nestedNodes.filter((inner) => {
              if (inner.type !== "JSXElement") {
                return false;
              }
              const innerName = elementName(inner);
              return nativeSelect
                ? innerName === "option"
                : itemLocals.has(innerName ?? "");
            }).length;
            const mappedLongList = nestedNodes.some(
              (inner) =>
                inner.type === "CallExpression" &&
                (longListLocals.has(mappedListName(inner) ?? "") ||
                  isMappedStaticArray(inner) ||
                  isMappedHelperCall(inner, longListHelpers)),
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

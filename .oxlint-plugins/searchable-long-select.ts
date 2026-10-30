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
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const SELECT_MODULE = "@stll/ui/select";
const SELECT_THRESHOLD = 30;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

const isSyntaxNode = (
  value: unknown,
): value is Record<string, unknown> & { type: string } =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const syntaxPropertyName = (value: unknown): string | null => {
  if (!isSyntaxNode(value)) {
    return null;
  }
  if (value.type === "Identifier" && typeof value.name === "string") {
    return value.name;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
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

const staticArrayLength = (node: unknown): number | null => {
  if (!isSyntaxNode(node)) {
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

const moduleExportsLongList = (
  filename: string,
  exportedName: string,
): boolean => {
  const cached = moduleLongListCache.get(filename);
  if (cached !== undefined) {
    return cached.has(exportedName);
  }
  const source = readFileSync(filename, "utf-8");
  const parsed = parseSync(filename, source);
  if (parsed.errors.length > 0) {
    return panic(`Unable to parse imported list source ${filename}`);
  }
  const { program } = parsed;
  if (!isSyntaxNode(program) || !Array.isArray(program.body)) {
    return panic(`Unable to parse imported list source ${filename}`);
  }
  const longBindings = new Set<string>();
  const exportedBindings = new Map<string, string>();
  for (const statement of program.body) {
    if (!isSyntaxNode(statement)) {
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (
      isSyntaxNode(declaration) &&
      declaration.type === "VariableDeclaration" &&
      Array.isArray(declaration.declarations)
    ) {
      for (const item of declaration.declarations) {
        if (
          !isSyntaxNode(item) ||
          !isSyntaxNode(item.id) ||
          item.id.type !== "Identifier" ||
          typeof item.id.name !== "string"
        ) {
          continue;
        }
        if ((staticArrayLength(item.init) ?? 0) > SELECT_THRESHOLD) {
          longBindings.add(item.id.name);
        }
        if (
          isSyntaxNode(item.init) &&
          item.init.type === "Identifier" &&
          typeof item.init.name === "string" &&
          longBindings.has(item.init.name)
        ) {
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
        if (!isSyntaxNode(specifier)) {
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

const referencesLongList = (
  node: unknown,
  names: ReadonlySet<string>,
): boolean => {
  let found = false;
  walk(node, (inner) => {
    if (
      inner.type === "Identifier" &&
      typeof inner.name === "string" &&
      names.has(inner.name)
    ) {
      found = true;
    }
  });
  return found;
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
            let hasNativeSelect = false;
            walk(program, (inner) => {
              if (
                inner.type === "JSXElement" &&
                elementName(inner) === "select"
              ) {
                hasNativeSelect = true;
              }
            });
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
                referencesLongList(inner.body, longListLocals)
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
                referencesLongList(inner.init.body, longListLocals)
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
            let itemCount = 0;
            let mappedLongList = false;
            walk(node, (inner) => {
              const innerName = elementName(inner);
              if (
                inner.type === "JSXElement" &&
                (nativeSelect
                  ? innerName === "option"
                  : itemLocals.has(innerName ?? ""))
              ) {
                itemCount += 1;
              }
              if (
                inner.type === "CallExpression" &&
                (longListLocals.has(mappedListName(inner) ?? "") ||
                  isMappedStaticArray(inner) ||
                  isMappedHelperCall(inner, longListHelpers))
              ) {
                mappedLongList = true;
              }
            });
            if (itemCount > SELECT_THRESHOLD || mappedLongList) {
              context.report({ node, messageId: "longSelect" });
            }
          },
        };
      },
    },
  },
});

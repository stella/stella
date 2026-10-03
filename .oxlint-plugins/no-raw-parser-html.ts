import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree, Variable } from "@oxlint/plugins";

import type { AstNode, ScopeContext } from "./utils.ts";
import {
  everyNode,
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveImportedExpression,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-raw-parser-html";
const OWNER =
  "apps/api/src/handlers/case-law/ingestion/parsers/shared-inlines.ts";
const CHEERIO_TYPES = new Set(["Cheerio", "CheerioAPI"]);
const SELECTION_METHODS = new Set([
  "add",
  "addBack",
  "children",
  "clone",
  "closest",
  "contents",
  "end",
  "eq",
  "filter",
  "find",
  "first",
  "has",
  "last",
  "next",
  "nextAll",
  "nextUntil",
  "not",
  "parent",
  "parents",
  "parentsUntil",
  "prev",
  "prevAll",
  "prevUntil",
  "siblings",
  "slice",
  "remove",
  "empty",
  "append",
  "prepend",
  "before",
  "after",
  "replaceWith",
  "wrap",
  "wrapAll",
  "wrapInner",
  "unwrap",
]);
const SELECTOR_METHODS = new Set([
  "find",
  "children",
  "filter",
  "not",
  "is",
  "closest",
  "remove",
]);
const COMPARISONS = new Set(["===", "!==", "==", "!="]);
type CheerioKind = "api" | "selection" | "xmlApi" | "xmlSelection";
const TABLE_TAGS = "(?:tr|td|th)";
const TABLE_SELECTOR = new RegExp(
  String.raw`(?:^|[\s>,+~(])${TABLE_TAGS}(?=$|[\s>,+~).#:[*])`,
  "iu",
);
const EXCLUDED_SELECTOR =
  /(?:^|[\s>,+~(])(?:script|style)(?=$|[\s>,+~).#:[*])/iu;
const ROW_SELECTOR = /(?:^|[\s>,+~(])tr(?=$|[\s>,+~).#:[*])/iu;
const TABLE_ROOT_SELECTOR = /(?:^|[\s>,+~(])table(?=$|[\s>,+~).#:[*])/iu;
const OTHER_TAG_SELECTOR = new RegExp(
  String.raw`(?:^|[\s>,+~(])(?!${TABLE_TAGS}(?=$|[\s>,+~).#:[*]))[a-z][a-z\d-]*(?=$|[\s>,+~).#:[*])`,
  "iu",
);

// Attribute values and quoted strings are not tag selectors: `[data-kind="td"]`
// and `[style]` describe ordinary visible elements.
const selectorTags = (selector: string): string => {
  const parts: string[] = [];
  let attributeDepth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector.charAt(index);
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      attributeDepth += 1;
      continue;
    }
    if (attributeDepth > 0) {
      if (character === "]") {
        attributeDepth -= 1;
      }
      continue;
    }
    parts.push(character);
  }
  return parts.join("");
};

class ParserHtmlProvenance {
  private readonly typeNames = new Map<string, string>();
  private readonly namespaces = new Set<string>();
  private programNodes: AstNode[] = [];
  htmlFile = false;

  private readonly context: ScopeContext;

  constructor(context: ScopeContext) {
    this.context = context;
  }

  readProgram(node: ESTree.Program): void {
    this.typeNames.clear();
    this.namespaces.clear();
    this.programNodes = everyNode(node);
    const loads = this.programNodes.filter(
      (candidate) =>
        candidate.type === "CallExpression" &&
        this.importedLoad(candidate.callee),
    );
    this.htmlFile =
      loads.length === 0 ||
      loads.some(
        (load) =>
          !Array.isArray(load.arguments) ||
          !this.isXmlOptions(load.arguments.at(1)),
      );
    for (const statement of node.body) {
      if (
        statement.type !== "ImportDeclaration" ||
        staticStringValue(statement.source) !== "cheerio"
      ) {
        continue;
      }
      for (const specifier of statement.specifiers) {
        const local =
          getImportLocalName(specifier) ??
          (isIdentifier(specifier.local) ? specifier.local.name : null);
        if (local === null) {
          continue;
        }
        if (
          specifier.type === "ImportNamespaceSpecifier" ||
          specifier.type === "ImportDefaultSpecifier"
        ) {
          this.namespaces.add(local);
          continue;
        }
        const imported = getImportedName(specifier);
        if (imported !== null && CHEERIO_TYPES.has(imported)) {
          this.typeNames.set(local, imported);
        }
      }
    }
  }

  isXmlOptions(node: unknown): boolean {
    let expression = unwrapExpression(node);
    if (isIdentifierReference(expression)) {
      const variable = resolveVariable(this.context, expression);
      expression =
        variable === null
          ? null
          : unwrapExpression(stableInitializer(variable));
    }
    return (
      expression?.type === "ObjectExpression" &&
      Array.isArray(expression.properties) &&
      expression.properties.some((property) => {
        if (!isAstNode(property) || property.type !== "Property") {
          return false;
        }
        const key = isIdentifier(property.key)
          ? property.key.name
          : staticStringValue(property.key);
        return (
          (key === "xml" || key === "xmlMode") &&
          isAstNode(property.value) &&
          ((property.value.type === "Literal" &&
            property.value.value === true) ||
            property.value.type === "ObjectExpression")
        );
      })
    );
  }

  importedLoad(node: unknown): boolean {
    const imported = resolveImportedExpression(this.context, node);
    return imported?.source === "cheerio" && imported.imported === "load";
  }

  constantString(node: unknown, seen = new Set<unknown>()): string | null {
    const expression = unwrapExpression(node);
    const literal = staticStringValue(expression);
    if (
      literal !== null ||
      !isIdentifierReference(expression) ||
      seen.has(expression)
    ) {
      return literal;
    }
    seen.add(expression);
    const variable = resolveVariable(this.context, expression);
    return variable === null
      ? null
      : this.constantString(stableInitializer(variable), seen);
  }

  propertyName(node: AstNode): string | null {
    return (
      memberPropertyName(node) ??
      (node.computed === true ? this.constantString(node.property) : null)
    );
  }

  stableObjectMemberKind(
    expression: AstNode,
    seen: Set<unknown>,
  ): CheerioKind | null {
    if (expression.type !== "MemberExpression") {
      return null;
    }
    const object = unwrapExpression(expression.object);
    const property = this.propertyName(expression);
    if (!isIdentifierReference(object) || property === null) {
      return null;
    }
    const variable = resolveVariable(this.context, object);
    const initializer = variable === null ? null : stableInitializer(variable);
    if (
      initializer?.type !== "ObjectExpression" ||
      !Array.isArray(initializer.properties)
    ) {
      return null;
    }
    const writesMember = this.programNodes.some((candidate) => {
      const target =
        candidate.type === "AssignmentExpression"
          ? candidate.left
          : candidate.type === "UpdateExpression" ||
              (candidate.type === "UnaryExpression" &&
                candidate.operator === "delete")
            ? candidate.argument
            : null;
      if (!isAstNode(target) || target.type !== "MemberExpression") {
        return false;
      }
      const targetObject = unwrapExpression(target.object);
      return (
        isIdentifierReference(targetObject) &&
        resolveVariable(this.context, targetObject) === variable &&
        this.propertyName(target) === property
      );
    });
    if (writesMember) {
      return null;
    }
    const value = initializer.properties.find((entry) => {
      if (!isAstNode(entry) || entry.type !== "Property") {
        return false;
      }
      const key = isIdentifier(entry.key)
        ? entry.key.name
        : this.constantString(entry.key);
      return key === property;
    });
    return isAstNode(value) && value.type === "Property"
      ? this.cheerioKind(value.value, seen)
      : null;
  }

  annotatedKind(
    node: unknown,
    seen = new Set<unknown>(),
  ): "api" | "selection" | null {
    if (seen.has(node)) {
      return null;
    }
    seen.add(node);
    if (!isAstNode(node)) {
      return null;
    }
    const annotation = node.typeAnnotation;
    if (!isAstNode(annotation)) {
      return null;
    }
    if (annotation.type === "TSTypeAnnotation") {
      return this.annotatedKind(annotation, seen);
    }
    if (annotation.type !== "TSTypeReference") {
      return null;
    }
    const name = annotation.typeName;
    let imported: string | undefined;
    if (isIdentifier(name)) {
      imported = this.typeNames.get(name.name);
      if (imported === undefined && isIdentifierReference(name)) {
        const variable = resolveVariable(this.context, name);
        const definitionNode: unknown = variable?.defs.at(0)?.node;
        if (
          isAstNode(definitionNode) &&
          definitionNode.type === "TSTypeAliasDeclaration"
        ) {
          return this.annotatedKind(definitionNode, seen);
        }
      }
    }
    if (
      isAstNode(name) &&
      name.type === "TSQualifiedName" &&
      isIdentifier(name.left) &&
      this.namespaces.has(name.left.name) &&
      isIdentifier(name.right)
    ) {
      imported = name.right.name;
    }
    if (imported === "CheerioAPI") {
      return "api";
    }
    return imported === "Cheerio" ? "selection" : null;
  }

  // Follow imported load aliases, stable local aliases, selection chains,
  // and typed helper parameters. A Response or Bun.file text read is not
  // a Cheerio selection, even inside a parser.
  cheerioKind(node: unknown, seen = new Set<unknown>()): CheerioKind | null {
    const expression = unwrapExpression(node);
    if (!isAstNode(expression) || seen.has(expression)) {
      return null;
    }
    seen.add(expression);
    if (isIdentifierReference(expression)) {
      const variable = resolveVariable(this.context, expression);
      return variable === null ? null : this.bindingKind(variable, seen);
    }
    if (expression.type === "MemberExpression") {
      return this.stableObjectMemberKind(expression, seen);
    }
    if (expression.type !== "CallExpression") {
      return null;
    }
    if (this.importedLoad(expression.callee)) {
      return Array.isArray(expression.arguments) &&
        this.isXmlOptions(expression.arguments.at(1))
        ? "xmlApi"
        : "api";
    }
    const calledKind = this.cheerioKind(expression.callee, new Set(seen));
    if (calledKind === "api") {
      return "selection";
    }
    if (calledKind === "xmlApi") {
      return "xmlSelection";
    }
    const callee = unwrapExpression(expression.callee);
    if (callee?.type !== "MemberExpression") {
      return null;
    }
    const receiver = this.cheerioKind(callee.object, seen);
    const method = this.propertyName(callee);
    if (receiver === "api" && method === "root") {
      return "selection";
    }
    if (receiver === "xmlApi" && method === "root") {
      return "xmlSelection";
    }
    if (
      receiver === "xmlSelection" &&
      method !== null &&
      SELECTION_METHODS.has(method)
    ) {
      return "xmlSelection";
    }
    return receiver === "selection" &&
      method !== null &&
      SELECTION_METHODS.has(method)
      ? "selection"
      : null;
  }

  excludedTag(node: unknown): boolean {
    const value = this.constantString(node)?.toLowerCase();
    return value === "script" || value === "style";
  }

  tableSelection(node: unknown, seen = new Set<unknown>()): boolean {
    const expression = unwrapExpression(node);
    if (!isAstNode(expression) || seen.has(expression)) {
      return false;
    }
    seen.add(expression);
    if (isIdentifierReference(expression)) {
      const variable = resolveVariable(this.context, expression);
      return (
        variable !== null &&
        this.tableSelection(stableInitializer(variable), seen)
      );
    }
    if (expression.type !== "CallExpression") {
      return false;
    }
    const callee = unwrapExpression(expression.callee);
    const selector = Array.isArray(expression.arguments)
      ? this.constantString(expression.arguments.at(0))
      : null;
    if (
      selector !== null &&
      TABLE_ROOT_SELECTOR.test(selectorTags(selector)) &&
      (this.cheerioKind(callee) === "api" ||
        (callee?.type === "MemberExpression" &&
          this.propertyName(callee) === "find"))
    ) {
      return true;
    }
    return (
      callee?.type === "MemberExpression" &&
      this.tableSelection(callee.object, seen)
    );
  }

  bindingKind(variable: Variable, seen: Set<unknown>): CheerioKind | null {
    const definition = variable.defs.at(0);
    const definitionNode: unknown = definition?.node;
    const initializer = stableInitializer(variable);
    if (initializer !== null) {
      return this.cheerioKind(initializer, seen);
    }
    const annotation =
      this.annotatedKind(definition?.name) ??
      this.annotatedKind(
        isAstNode(definitionNode) &&
          definitionNode.type === "VariableDeclarator"
          ? definitionNode.id
          : definitionNode,
      );
    if (annotation === null) {
      return null;
    }
    const xmlOnly = this.parameterXmlMode(variable, seen);
    return xmlOnly
      ? annotation === "api"
        ? "xmlApi"
        : "xmlSelection"
      : annotation;
  }

  parameterXmlMode(variable: Variable, seen: Set<unknown>): boolean {
    let xmlOnly = !this.htmlFile;
    if (xmlOnly) {
      return true;
    }
    const definition = variable.defs.at(0);
    const definitionNode: unknown = definition?.node;
    // A typed local helper's XML parameters retain the caller's mode;
    // mixed files can read XML metadata and HTML bodies separately.
    if (
      definition?.type === "Parameter" &&
      isAstNode(definitionNode) &&
      Array.isArray(definitionNode.params)
    ) {
      const index = definitionNode.params.indexOf(definition.name);
      const callers = this.programNodes.filter((candidate) => {
        if (
          candidate.type !== "CallExpression" ||
          !isIdentifierReference(candidate.callee)
        ) {
          return false;
        }
        const called = resolveVariable(this.context, candidate.callee);
        return called !== null && stableInitializer(called) === definitionNode;
      });
      if (index !== -1 && callers.length > 0) {
        xmlOnly = callers.every((caller) => {
          const kind = Array.isArray(caller.arguments)
            ? this.cheerioKind(caller.arguments.at(index), new Set(seen))
            : null;
          return kind === "xmlApi" || kind === "xmlSelection";
        });
      }
    }
    return xmlOnly;
  }
}

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          rawText:
            "Read HTML text with visibleHtmlText from shared-inlines.ts; raw Cheerio .text() retains script and style content.",
          tableDescendants:
            "Read a table's own rows with ownTableRows and its direct cells with .children('td, th'); descendant row/cell selectors visit nested tables twice.",
          excludedTags:
            "Use isExcludedHtmlTag or visibleHtmlText from shared-inlines.ts; script/style exclusions belong to that owner.",
        },
      },
      createOnce(context) {
        let enabled = false;
        const provenance = new ParserHtmlProvenance(context);

        return {
          before() {
            const filename = filenameForContext(context);
            enabled = filename !== OWNER && !filename.endsWith(`/${OWNER}`);
          },
          Program(node) {
            provenance.readProgram(node);
          },
          CallExpression(node) {
            if (!enabled) {
              return;
            }
            const callee = unwrapExpression(node.callee);
            if (callee === null) {
              return;
            }
            const apiCall = provenance.cheerioKind(callee) === "api";
            const memberCall = callee.type === "MemberExpression";
            const receiver = memberCall
              ? provenance.cheerioKind(callee.object)
              : null;
            const method = memberCall ? provenance.propertyName(callee) : null;
            if (
              (receiver === "api" || receiver === "selection") &&
              method === "text" &&
              node.arguments.length === 0
            ) {
              context.report({ node, messageId: "rawText" });
            }
            const selector = provenance.constantString(node.arguments.at(0));
            if (
              selector === null ||
              (!apiCall &&
                ((receiver !== "api" && receiver !== "selection") ||
                  method === null ||
                  !SELECTOR_METHODS.has(method)))
            ) {
              return;
            }
            const tags = selectorTags(selector);
            const mixedCellCandidates =
              tags.includes(",") &&
              OTHER_TAG_SELECTOR.test(tags) &&
              !ROW_SELECTOR.test(tags);
            if (
              (apiCall || method === "find") &&
              TABLE_SELECTOR.test(tags) &&
              (!mixedCellCandidates ||
                TABLE_ROOT_SELECTOR.test(tags) ||
                (memberCall && provenance.tableSelection(callee.object)))
            ) {
              context.report({ node, messageId: "tableDescendants" });
            }
            if (EXCLUDED_SELECTOR.test(tags)) {
              const isPresenceCheck =
                isAstNode(node.parent) &&
                node.parent.type === "MemberExpression" &&
                provenance.propertyName(node.parent) === "length";
              if (!isPresenceCheck) {
                context.report({ node, messageId: "excludedTags" });
              }
            }
          },
          BinaryExpression(node) {
            if (
              enabled &&
              provenance.htmlFile &&
              COMPARISONS.has(node.operator) &&
              (provenance.excludedTag(node.left) ||
                provenance.excludedTag(node.right))
            ) {
              context.report({ node, messageId: "excludedTags" });
            }
          },
          SwitchCase(node) {
            if (
              enabled &&
              provenance.htmlFile &&
              provenance.excludedTag(node.test)
            ) {
              context.report({ node, messageId: "excludedTags" });
            }
          },
          ArrayExpression(node) {
            if (
              enabled &&
              provenance.htmlFile &&
              node.elements.some((element) => provenance.excludedTag(element))
            ) {
              context.report({ node, messageId: "excludedTags" });
            }
          },
        };
      },
    },
  },
});

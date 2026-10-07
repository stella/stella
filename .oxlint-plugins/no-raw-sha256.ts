import {
  type Context,
  type ESTree,
  type Variable,
  type Visitor,
  eslintCompatPlugin,
} from "@oxlint/plugins";
import { panic } from "better-result";

import { SHA256_OWNERS } from "../scripts/sha256-owners.ts";
import {
  type ScopeContext,
  dynamicModuleSource,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  memberPropertyName,
  patternKeyFor,
  repoRelativeFilename,
  resolveImportedExpression,
  resolveVariable,
  staticStringValue,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const CRYPTO_MODULES = new Map([
  ["node:crypto", "nodeCrypto"],
  ["crypto", "nodeCrypto"],
  ["bun", "Bun"],
]);

type CryptoImportPathOptions = { source: string; imported: string };
const cryptoImportPath = ({
  source,
  imported,
}: CryptoImportPathOptions): string | null => {
  const runtime = CRYPTO_MODULES.get(source);
  if (runtime === "nodeCrypto") {
    switch (imported) {
      case "createHash":
        return "createHash";
      case "webcrypto":
        return "crypto";
      case "subtle":
        return "crypto.subtle";
      case "default":
      case "*":
        return "nodeCrypto";
      default:
        return null;
    }
  }
  if (runtime === "Bun") {
    switch (imported) {
      case "CryptoHasher":
        return "Bun.CryptoHasher";
      case "SHA256":
        return "Bun.SHA256";
      case "default":
      case "*":
        return "Bun";
      default:
        return null;
    }
  }
  return null;
};

const importedPrimitivePath = (
  context: ScopeContext,
  node: unknown,
): string | null => {
  const imported = resolveImportedExpression(context, node);
  return imported === null ? null : cryptoImportPath(imported);
};

// Resolve immutable aliases for call classification. Escaped primitive values
// are rejected at acquisition; runtime-computed keys remain a syntax boundary.
const primitivePath = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return null;
  }
  seen.add(node);
  const imported = importedPrimitivePath(context, node);
  if (imported !== null) {
    return imported;
  }
  if (node.type === "MemberExpression") {
    const base = primitivePath(context, node.object, seen);
    const key = memberPropertyName(node);
    return base !== null && key !== null ? `${base}.${key}` : null;
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  if (variable === null || variable.defs.length === 0) {
    if (["window", "globalThis", "self"].includes(node.name)) {
      return "";
    }
    return node.name === "crypto" || node.name === "Bun" ? node.name : null;
  }
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || !isSingleAssignment(variable)) {
    return null;
  }
  const declaration: unknown = definition?.node;
  if (!isAstNode(declaration) || declaration.type !== "VariableDeclarator") {
    return null;
  }
  const base = primitivePath(context, declaration.init, seen);
  if (base === null) {
    return null;
  }
  if (isIdentifier(declaration.id)) {
    return base;
  }
  if (!isAstNode(declaration.id) || declaration.id.type !== "ObjectPattern") {
    return null;
  }
  const key = patternKeyFor(declaration.id, definition?.name);
  return key === null ? null : `${base}.${key}`;
};

const normalizedPath = (value: string | null) =>
  value
    ?.replace(/^\./u, "")
    .replace(/^nodeCrypto\.webcrypto/u, "crypto")
    .replace(/^nodeCrypto\.createHash$/u, "createHash")
    .replace(/^nodeCrypto\.subtle/u, "crypto.subtle") ?? null;

const algorithmName = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return null;
  }
  seen.add(node);
  const literal = staticStringValue(node);
  if (literal !== null) {
    return literal;
  }
  if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
    for (const property of node.properties.toReversed()) {
      if (!isAstNode(property) || property.type === "SpreadElement") {
        return null;
      }
      const key =
        property.computed === true
          ? staticStringValue(property.key)
          : isIdentifier(property.key)
            ? property.key.name
            : staticStringValue(property.key);
      if (key === "name") {
        return algorithmName(context, property.value, seen);
      }
    }
    return null;
  }
  if (!isIdentifierReference(node)) {
    return null;
  }
  const variable = resolveVariable(context, node);
  return variable === null
    ? null
    : algorithmName(context, stableInitializer(variable), seen);
};

const isPrimitive = (value: string | null) =>
  value === "createHash" ||
  value === "Bun.CryptoHasher" ||
  value === "Bun.SHA256" ||
  value === "Bun.SHA256.hash" ||
  value === "crypto.subtle.digest";
// Exported namespaces hide the primitive behind an unrecognized import source.
// Confine their acquisition at the bridge rather than tracing arbitrary modules.
const isCryptoNamespace = (value: string | null) =>
  value === "nodeCrypto" ||
  value === "Bun" ||
  value === "crypto" ||
  value === "crypto.subtle";
const isCryptoBearingValue = (value: string | null) =>
  isPrimitive(value) || isCryptoNamespace(value);

const isExportValue = (node: unknown): boolean => {
  let current = node;
  while (isAstNode(current) && isAstNode(current.parent)) {
    const parent = current.parent;
    if (
      parent.type === "ExportDefaultDeclaration" ||
      parent.type === "ExportNamedDeclaration"
    ) {
      return true;
    }
    if (
      ![
        "Property",
        "ObjectExpression",
        "ArrayExpression",
        "SpreadElement",
        "ConditionalExpression",
        "LogicalExpression",
        "SequenceExpression",
        "VariableDeclarator",
        "VariableDeclaration",
        "TSAsExpression",
        "TSNonNullExpression",
        "TSSatisfiesExpression",
        "TSTypeAssertion",
      ].includes(parent.type)
    ) {
      return false;
    }
    current = parent;
  }
  return false;
};

type CryptoExportSource =
  | { type: "expression"; value: unknown }
  | { type: "path"; value: string };

type CryptoSourceOptions = {
  context: ScopeContext;
  source: CryptoExportSource;
  seen: Set<unknown>;
};
const sourceContainsCryptoExport = ({
  context,
  source,
  seen,
}: CryptoSourceOptions): boolean => {
  switch (source.type) {
    case "path":
      return isCryptoBearingValue(normalizedPath(source.value));
    case "expression":
      return containsCryptoExport({ context, value: source.value, seen });
    default:
      source satisfies never;
      return panic("Unexpected crypto export source");
  }
};

const expandCryptoSource = ({
  context,
  source,
  seen,
}: CryptoSourceOptions): CryptoExportSource[] => {
  if (source.type === "path") {
    return [source];
  }
  const node = unwrapExpression(source.value);
  if (!isAstNode(node) || seen.has(node)) {
    return [];
  }
  const path = normalizedPath(primitivePath(context, node));
  if (path !== null) {
    return [{ type: "path", value: path }];
  }
  const loaded = dynamicModuleSource(node);
  if (loaded !== null) {
    if (
      node.type === "CallExpression" &&
      isIdentifierReference(node.callee) &&
      resolveVariable(context, node.callee) !== null
    ) {
      return [];
    }
    const runtime = CRYPTO_MODULES.get(loaded);
    return runtime === undefined ? [] : [{ type: "path", value: runtime }];
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    if (variable === null) {
      return [];
    }
    const aliases = cryptoVariableSources({
      context,
      variable,
      seen: new Set([...seen, node]),
    });
    return aliases.flatMap((candidate) =>
      expandCryptoSource({
        context,
        source: candidate,
        seen: new Set([...seen, node]),
      }),
    );
  }
  if (node.type === "MemberExpression") {
    const key = cryptoMemberKey(node);
    if (key === null) {
      return [];
    }
    return selectCryptoSources({
      context,
      source: { type: "expression", value: node.object },
      key,
      seen: new Set([...seen, node]),
    }).flatMap((candidate) =>
      expandCryptoSource({
        context,
        source: candidate,
        seen: new Set([...seen, node]),
      }),
    );
  }
  const branches = compoundCryptoSources({
    context,
    source: { type: "expression", value: node },
    seen: new Set([...seen, node]),
  });
  return branches ?? [{ type: "expression", value: node }];
};

const compoundCryptoSources = ({
  context,
  source,
  seen,
}: CryptoSourceOptions): CryptoExportSource[] | null => {
  if (source.type !== "expression") {
    return null;
  }
  const node = unwrapExpression(source.value);
  if (!isAstNode(node)) {
    return null;
  }
  let values: readonly unknown[];
  switch (node.type) {
    case "ConditionalExpression":
      values = [node.consequent, node.alternate];
      break;
    case "LogicalExpression":
      values = [node.left, node.right];
      break;
    case "SequenceExpression":
      values = Array.isArray(node.expressions) ? [node.expressions.at(-1)] : [];
      break;
    default:
      return null;
  }
  return values.flatMap((value) =>
    expandCryptoSource({
      context,
      source: { type: "expression", value },
      seen: new Set(seen),
    }),
  );
};

const patternPropertyName = (property: unknown): string | null => {
  if (!isAstNode(property) || property.type !== "Property") {
    return null;
  }
  return property.computed
    ? staticStringValue(property.key)
    : isIdentifier(property.key)
      ? property.key.name
      : staticStringValue(property.key);
};

const cryptoMemberKey = (node: unknown): string | number | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  if (
    node.computed === true &&
    isAstNode(node.property) &&
    node.property.type === "Literal" &&
    typeof node.property.value === "number"
  ) {
    return Number.isInteger(node.property.value) && node.property.value >= 0
      ? node.property.value
      : null;
  }
  return memberPropertyName(node);
};

const cryptoArraySources = ({
  context,
  source,
  seen,
}: CryptoSourceOptions): CryptoExportSource[][] => {
  if (source.type !== "expression") {
    return [[source]];
  }
  const node = unwrapExpression(source.value);
  if (
    !isAstNode(node) ||
    node.type !== "ArrayExpression" ||
    !Array.isArray(node.elements) ||
    seen.has(node)
  ) {
    return [];
  }
  const nextSeen = new Set([...seen, node]);
  let alternatives: CryptoExportSource[][] = [[]];
  for (const element of node.elements) {
    const choices =
      isAstNode(element) && element.type === "SpreadElement"
        ? expandCryptoSource({
            context,
            source: { type: "expression", value: element.argument },
            seen: nextSeen,
          }).flatMap((candidate): CryptoExportSource[][] => {
            const expanded =
              candidate.type === "expression"
                ? unwrapExpression(candidate.value)
                : null;
            return isAstNode(expanded) && expanded.type === "ArrayExpression"
              ? cryptoArraySources({
                  context,
                  source: candidate,
                  seen: nextSeen,
                })
              : [[candidate]];
          })
        : [
            [
              {
                type: "expression",
                value: element,
              } satisfies CryptoExportSource,
            ],
          ];
    const combined: CryptoExportSource[][] = [];
    for (const prefix of alternatives) {
      for (const choice of choices) {
        combined.push(prefix.concat(choice));
      }
    }
    alternatives = combined;
  }
  return alternatives;
};

type CryptoMemberSourceOptions = CryptoSourceOptions & { key: string | number };
const selectCryptoSources = ({
  context,
  source,
  key,
  seen,
}: CryptoMemberSourceOptions): CryptoExportSource[] =>
  expandCryptoSource({ context, source, seen }).flatMap(
    (candidate): CryptoExportSource[] => {
      if (candidate.type === "path") {
        return [{ type: "path", value: `${candidate.value}.${key}` }];
      }
      const node = unwrapExpression(candidate.value);
      if (!isAstNode(node)) {
        return [];
      }
      if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
        if (typeof key === "string" && !/^(?:0|[1-9]\d*)$/u.test(key)) {
          return [];
        }
        return cryptoArraySources({ context, source: candidate, seen }).flatMap(
          (elements) => {
            const selected = elements.at(Number(key));
            return selected === undefined ? [] : [selected];
          },
        );
      }
      if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
        return [];
      }
      return node.properties.flatMap((property): CryptoExportSource[] => {
        if (!isAstNode(property)) {
          return [];
        }
        if (property.type === "SpreadElement") {
          return selectCryptoSources({
            context,
            source: { type: "expression", value: property.argument },
            key,
            seen: new Set([...seen, node]),
          });
        }
        return patternPropertyName(property) === String(key)
          ? [{ type: "expression", value: property.value }]
          : [];
      });
    },
  );

type CryptoRestSourceOptions = CryptoSourceOptions & {
  selection:
    | { type: "object-rest"; excludedKeys: readonly string[] }
    | { type: "array-rest"; start: number };
};
const restCryptoSources = ({
  context,
  source,
  selection,
  seen,
}: CryptoRestSourceOptions): CryptoExportSource[] =>
  expandCryptoSource({ context, source, seen }).flatMap(
    (candidate): CryptoExportSource[] => {
      if (candidate.type === "path") {
        return [candidate];
      }
      const node = unwrapExpression(candidate.value);
      if (!isAstNode(node)) {
        return [];
      }
      if (
        selection.type === "array-rest" &&
        node.type === "ArrayExpression" &&
        Array.isArray(node.elements)
      ) {
        return cryptoArraySources({ context, source: candidate, seen }).flatMap(
          (elements) => elements.slice(selection.start),
        );
      }
      if (
        selection.type !== "object-rest" ||
        node.type !== "ObjectExpression" ||
        !Array.isArray(node.properties)
      ) {
        return [];
      }
      return node.properties.flatMap((property): CryptoExportSource[] => {
        if (!isAstNode(property)) {
          return [];
        }
        if (property.type === "SpreadElement") {
          return restCryptoSources({
            context,
            source: { type: "expression", value: property.argument },
            selection,
            seen: new Set([...seen, node]),
          });
        }
        const key = patternPropertyName(property);
        return key !== null && selection.excludedKeys.includes(key)
          ? []
          : [{ type: "expression", value: property.value }];
      });
    },
  );

type CryptoPatternSourceOptions = CryptoSourceOptions & {
  pattern: unknown;
  bindingName: string;
};
const bindingCryptoSources = ({
  context,
  source,
  pattern,
  bindingName,
  seen,
}: CryptoPatternSourceOptions): CryptoExportSource[] => {
  if (!isAstNode(pattern)) {
    return [];
  }
  if (isIdentifier(pattern)) {
    return pattern.name === bindingName ? [source] : [];
  }
  if (pattern.type === "AssignmentPattern") {
    return [
      source,
      { type: "expression", value: pattern.right } satisfies CryptoExportSource,
    ].flatMap((candidate) =>
      bindingCryptoSources({
        context,
        source: candidate,
        pattern: pattern.left,
        bindingName,
        seen: new Set(seen),
      }),
    );
  }
  if (pattern.type === "RestElement") {
    return bindingCryptoSources({
      context,
      source,
      pattern: pattern.argument,
      bindingName,
      seen,
    });
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)) {
    return objectBindingCryptoSources({
      context,
      source,
      pattern,
      bindingName,
      seen,
    });
  }
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) {
    return pattern.elements.flatMap((element, index) => {
      const sources =
        isAstNode(element) && element.type === "RestElement"
          ? restCryptoSources({
              context,
              source,
              selection: { type: "array-rest", start: index },
              seen: new Set(seen),
            })
          : selectCryptoSources({
              context,
              source,
              key: index,
              seen: new Set(seen),
            });
      if (sources.length === 0) {
        sources.push({ type: "expression", value: undefined });
      }
      return sources.flatMap((candidate) =>
        bindingCryptoSources({
          context,
          source: candidate,
          pattern: element,
          bindingName,
          seen: new Set(seen),
        }),
      );
    });
  }
  return [];
};

const objectBindingCryptoSources = ({
  context,
  source,
  pattern,
  bindingName,
  seen,
}: CryptoPatternSourceOptions): CryptoExportSource[] => {
  if (!isAstNode(pattern) || !Array.isArray(pattern.properties)) {
    return [];
  }
  const excludedKeys = pattern.properties
    .map(patternPropertyName)
    .filter((key): key is string => key !== null);
  return pattern.properties.flatMap((property) => {
    if (!isAstNode(property)) {
      return [];
    }
    const key = patternPropertyName(property);
    const sources =
      property.type === "RestElement"
        ? restCryptoSources({
            context,
            source,
            selection: { type: "object-rest", excludedKeys },
            seen: new Set(seen),
          })
        : key === null
          ? []
          : selectCryptoSources({ context, source, key, seen: new Set(seen) });
    const child =
      property.type === "RestElement" ? property.argument : property.value;
    if (sources.length === 0) {
      sources.push({ type: "expression", value: undefined });
    }
    return sources.flatMap((candidate) =>
      bindingCryptoSources({
        context,
        source: candidate,
        pattern: child,
        bindingName,
        seen: new Set(seen),
      }),
    );
  });
};

type CryptoVariableExportOptions = {
  context: ScopeContext;
  variable: Variable;
  seen: Set<unknown>;
};
const cryptoVariableSources = ({
  context,
  variable,
  seen,
}: CryptoVariableExportOptions): CryptoExportSource[] => {
  const sources = variable.defs.flatMap((definition) => {
    const declaration: unknown = definition.node;
    if (
      !isAstNode(declaration) ||
      declaration.type !== "VariableDeclarator" ||
      !isIdentifier(definition.name)
    ) {
      return [];
    }
    return bindingCryptoSources({
      context,
      source: { type: "expression", value: declaration.init },
      pattern: declaration.id,
      bindingName: definition.name.name,
      seen: new Set(seen),
    });
  });
  for (const reference of variable.references) {
    if (!reference.init && reference.writeExpr !== null) {
      sources.push({ type: "expression", value: reference.writeExpr });
    }
  }
  return sources;
};

const variableContainsCryptoExport = (
  options: CryptoVariableExportOptions,
): boolean =>
  cryptoVariableSources(options).some((source) =>
    sourceContainsCryptoExport({
      context: options.context,
      source,
      seen: new Set(options.seen),
    }),
  );

const exportedPatternBindings = (
  pattern: unknown,
): ESTree.IdentifierReference[] => {
  if (!isAstNode(pattern)) {
    return [];
  }
  if (isIdentifierReference(pattern)) {
    return [pattern];
  }
  if (pattern.type === "AssignmentPattern") {
    return exportedPatternBindings(pattern.left);
  }
  if (pattern.type === "RestElement") {
    return exportedPatternBindings(pattern.argument);
  }
  if (pattern.type === "ObjectPattern" && Array.isArray(pattern.properties)) {
    return pattern.properties.flatMap((property) =>
      isAstNode(property)
        ? exportedPatternBindings(
            property.type === "RestElement"
              ? property.argument
              : property.value,
          )
        : [],
    );
  }
  if (pattern.type === "ArrayPattern" && Array.isArray(pattern.elements)) {
    return pattern.elements.flatMap(exportedPatternBindings);
  }
  return [];
};

type CryptoExportOptions = {
  context: ScopeContext;
  value: unknown;
  seen?: Set<unknown>;
};
const containsCryptoExport = ({
  context,
  value,
  seen = new Set<unknown>(),
}: CryptoExportOptions): boolean => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isCryptoBearingValue(normalizedPath(primitivePath(context, node)))) {
    return true;
  }
  const loaded = dynamicModuleSource(node);
  if (loaded !== null) {
    if (
      node.type === "CallExpression" &&
      isIdentifierReference(node.callee) &&
      resolveVariable(context, node.callee) !== null
    ) {
      return false;
    }
    return CRYPTO_MODULES.has(loaded);
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      variableContainsCryptoExport({ context, variable, seen })
    );
  }
  if (node.type === "MemberExpression") {
    const key = cryptoMemberKey(node);
    return (
      key !== null &&
      selectCryptoSources({
        context,
        source: { type: "expression", value: node.object },
        key,
        seen: new Set(seen),
      }).some((source) =>
        sourceContainsCryptoExport({ context, source, seen: new Set(seen) }),
      )
    );
  }
  if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
    return node.properties.some(
      (property) =>
        isAstNode(property) &&
        containsCryptoExport({
          context,
          value:
            property.type === "SpreadElement"
              ? property.argument
              : property.value,
          seen,
        }),
    );
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.some((element) =>
      containsCryptoExport({ context, value: element, seen }),
    );
  }
  if (node.type === "SpreadElement") {
    return containsCryptoExport({
      context,
      value: node.argument,
      seen,
    });
  }
  if (node.type === "ConditionalExpression") {
    return (
      containsCryptoExport({
        context,
        value: node.consequent,
        seen,
      }) ||
      containsCryptoExport({
        context,
        value: node.alternate,
        seen,
      })
    );
  }
  if (node.type === "LogicalExpression") {
    return (
      containsCryptoExport({
        context,
        value: node.left,
        seen,
      }) || containsCryptoExport({ context, value: node.right, seen })
    );
  }
  if (node.type === "SequenceExpression" && Array.isArray(node.expressions)) {
    return containsCryptoExport({
      context,
      value: node.expressions.at(-1),
      seen,
    });
  }
  return false;
};

type RawMemberAccessOptions = {
  primitive: string | null;
  property: string | null;
};
const isRawMemberAccess = ({ primitive, property }: RawMemberAccessOptions) =>
  isPrimitive(primitive) &&
  !(primitive === "Bun.SHA256" && property === "hash");

const isAbsentKey = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): boolean => {
  if (value === undefined) {
    return true;
  }
  const key = unwrapExpression(value);
  if (!isAstNode(key) || seen.has(key)) {
    return false;
  }
  seen.add(key);
  if (key.type === "UnaryExpression" && key.operator === "void") {
    return true;
  }
  if (!isIdentifierReference(key)) {
    return false;
  }
  const variable = resolveVariable(context, key);
  if (variable === null || variable.defs.length === 0) {
    return key.name === "undefined";
  }
  const initializer = stableInitializer(variable);
  return initializer !== null && isAbsentKey(context, initializer, seen);
};

const isExemptFile = (filename: string, options: unknown) => {
  if (Object.keys(SHA256_OWNERS).some((owner) => filename === owner)) {
    return true;
  }
  if (typeof options !== "object" || options === null) {
    return false;
  }
  const files: unknown = Reflect.get(options, "allowedFiles");
  return (
    Array.isArray(files) &&
    files.some((file: unknown) => typeof file === "string" && filename === file)
  );
};

type CryptoExportVisitorOptions = { context: Context; isExempt: () => boolean };
const cryptoExportVisitors = ({
  context,
  isExempt,
}: CryptoExportVisitorOptions): Visitor => ({
  ExportDefaultDeclaration(node) {
    if (
      !isExempt() &&
      containsCryptoExport({
        context,
        value: node.declaration,
      })
    ) {
      context.report({ node, messageId: "owned" });
    }
  },
  ExportAllDeclaration(node) {
    if (node.exportKind === "type") {
      return;
    }
    if (!isExempt() && CRYPTO_MODULES.has(node.source.value)) {
      context.report({ node, messageId: "owned" });
    }
  },
  ExportNamedDeclaration(node) {
    if (node.exportKind === "type") {
      return;
    }
    if (
      isExempt() ||
      (node.source !== null && !CRYPTO_MODULES.has(node.source.value))
    ) {
      return;
    }
    if (node.declaration?.type === "VariableDeclaration") {
      for (const declaration of node.declaration.declarations) {
        for (const binding of exportedPatternBindings(declaration.id)) {
          if (containsCryptoExport({ context, value: binding })) {
            context.report({ node: binding, messageId: "owned" });
          }
        }
      }
    }
    for (const specifier of node.specifiers) {
      if (specifier.exportKind === "type") {
        continue;
      }
      const name = isIdentifier(specifier.local)
        ? specifier.local.name
        : staticStringValue(specifier.local);
      if (
        node.source === null
          ? containsCryptoExport({
              context,
              value: specifier.local,
            })
          : isCryptoBearingValue(
              cryptoImportPath({
                source: node.source.value,
                imported: name ?? "",
              }),
            )
      ) {
        context.report({ node: specifier, messageId: "owned" });
      }
    }
  },
});

export default eslintCompatPlugin({
  meta: { name: "no-raw-sha256" },
  rules: {
    "no-raw-sha256": {
      meta: {
        type: "problem",
        schema: [
          {
            type: "object",
            properties: {
              allowedFiles: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          owned:
            "Use the SHA-256 owner for this runtime; raw SHA-256 primitives are confined to the registered owners.",
        },
      },
      createOnce(context) {
        const isExempt = () =>
          isExemptFile(repoRelativeFilename(context), context.options.at(0));
        const escaped = (
          node: ESTree.IdentifierReference | ESTree.MemberExpression,
        ) => {
          if (isExempt() || !isAstNode(node)) {
            return;
          }
          let parent: unknown = node.parent;
          while (isAstNode(parent) && unwrapExpression(parent) === node) {
            parent = parent.parent;
          }
          if (
            !isAstNode(parent) ||
            parent.type === "ExportSpecifier" ||
            parent.type.startsWith("TS")
          ) {
            return;
          }
          if (
            parent.type === "Property" &&
            isAstNode(parent.parent) &&
            parent.parent.type === "ObjectPattern"
          ) {
            return;
          }
          if (
            (parent.type === "CallExpression" ||
              parent.type === "NewExpression") &&
            unwrapExpression(parent.callee) === node
          ) {
            return;
          }
          if (parent.type === "MemberExpression") {
            const path = normalizedPath(primitivePath(context, node));
            if (
              unwrapExpression(parent.object) === node &&
              isRawMemberAccess({
                primitive: path,
                property: memberPropertyName(parent),
              })
            ) {
              context.report({ node, messageId: "owned" });
            }
            return;
          }
          if (parent.type.startsWith("Import")) {
            return;
          }
          if (parent.type === "VariableDeclarator" && parent.id === node) {
            return;
          }
          if (
            parent.type === "Property" &&
            parent.key === node &&
            parent.shorthand !== true
          ) {
            return;
          }
          const path = normalizedPath(primitivePath(context, node));
          if (
            isCryptoNamespace(path) &&
            parent.type === "VariableDeclarator" &&
            isAstNode(parent.id) &&
            parent.id.type === "ObjectPattern"
          ) {
            return;
          }
          if (
            isExportValue(node) ||
            !(isPrimitive(path) || path === "nodeCrypto")
          ) {
            return;
          }
          context.report({ node, messageId: "owned" });
        };
        const check = (node: ESTree.CallExpression | ESTree.NewExpression) => {
          if (isExempt()) {
            return;
          }
          const callee = unwrapExpression(node.callee);
          if (isIdentifierReference(callee)) {
            const variable = resolveVariable(context, callee);
            // The initializer/destructuring already reports this acquisition.
            if (variable?.defs.at(0)?.type === "Variable") {
              return;
            }
          }
          if (!Array.isArray(node.arguments)) {
            return;
          }
          const primitive = normalizedPath(primitivePath(context, node.callee));
          const algorithm = algorithmName(context, node.arguments.at(0));
          const sha256 =
            algorithm?.toLowerCase().replaceAll("-", "") === "sha256";
          if (primitive === "crypto.subtle.digest") {
            // CMS verification selects several digest algorithms from an OID.
            if (!sha256) {
              return;
            }
          } else if (primitive === "Bun.CryptoHasher") {
            const absentKey = isAbsentKey(context, node.arguments.at(1));
            if (!absentKey || (algorithm !== null && !sha256)) {
              return;
            }
          } else if (primitive === "createHash") {
            if (algorithm !== null && !sha256) {
              return;
            }
          } else if (
            primitive !== "Bun.SHA256" &&
            primitive !== "Bun.SHA256.hash"
          ) {
            return;
          }
          context.report({ node, messageId: "owned" });
        };
        return {
          CallExpression: check,
          NewExpression: check,
          Identifier(node) {
            if (isIdentifierReference(node)) {
              escaped(node);
            }
          },
          MemberExpression: escaped,
          VariableDeclarator(node) {
            if (isExempt() || node.id.type !== "ObjectPattern") {
              return;
            }
            for (const property of node.id.properties) {
              if (property.type !== "Property") {
                continue;
              }
              const key = property.computed
                ? staticStringValue(property.key)
                : isIdentifier(property.key)
                  ? property.key.name
                  : staticStringValue(property.key);
              const base = normalizedPath(primitivePath(context, node.init));
              const path =
                base === null || key === null
                  ? null
                  : normalizedPath(`${base}.${key}`);
              if (isPrimitive(path) && !isExportValue(node)) {
                context.report({ node: property, messageId: "owned" });
              }
            }
          },
          ...cryptoExportVisitors({ context, isExempt }),
        };
      },
    },
  },
});

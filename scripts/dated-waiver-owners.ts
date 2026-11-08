// Pure readers of dated waiver owner files. The blocking expiry check imports
// these, so this module must stay free of network and process access; probes
// and removals that need them live in dated-waiver-probes.ts.
import { panic } from "better-result";
import * as v from "valibot";

import {
  type CallExpression,
  type Expression,
  type Node,
  type ObjectExpression,
  type ParsedSource,
  parseSource,
  staticPropertyName,
  type StringLiteral,
} from "../packages/scripts/src/syntax-tree";
import { DOC_SOURCE_FILE } from "./dated-waiver-core";

// Offsets must come from a parseable owner, never from regex over source text.
export const parseOwner = (source: string, file: string) =>
  parseSource(file, source);

const unwrap = (node: Expression): Expression => {
  let value = node;
  while (
    value.type === "ParenthesizedExpression" ||
    value.type === "TSSatisfiesExpression" ||
    value.type === "TSAsExpression" ||
    value.type === "TSNonNullExpression"
  ) {
    value = value.expression;
  }
  return value;
};

/**
 * One documentation waiver as its owner declares it: the element a removal
 * deletes, and the string literals its checkedAt and expiresAt come from.
 * Entries built from one shared date constant share those literal nodes.
 */
export type DocumentationSite = {
  dependency: string;
  node: Node;
  declaration: Node;
  checkedAt: StringLiteral | undefined;
  expiresAt: StringLiteral | undefined;
};

type DocumentationOwner = {
  ast: ParsedSource;
  registry: ObjectExpression;
  sites: DocumentationSite[];
};

// Reads the declaration shapes the owner uses: inline objects, `.concat`,
// spreads, and `.map` over dependency names or `[name, urls]` tuples, with
// dates from literals or top-level string constants. Any other shape fails
// closed rather than being skipped.
export const readDocumentationOwner = (source: string): DocumentationOwner => {
  const ast = parseOwner(source, DOC_SOURCE_FILE);
  const declarations = new Map<string, Expression>();
  for (const statement of ast.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") {
      continue;
    }
    for (const variable of declaration.declarations) {
      if (variable.id.type === "Identifier" && variable.init) {
        declarations.set(variable.id.name, variable.init);
      }
    }
  }
  const resolve = (node: Expression, depth = 0): Expression => {
    const value = unwrap(node);
    if (value.type !== "Identifier") {
      return value;
    }
    const declared = declarations.get(value.name);
    if (declared === undefined || depth > 8) {
      return panic(
        `Documentation waiver reference is not a top-level constant: ${value.name}`,
      );
    }
    return resolve(declared, depth + 1);
  };
  const owner = declarations.get("DOC_SOURCE_EXCLUSIONS");
  const registry = declarations.get("DOC_SOURCES");
  const registryObject = registry === undefined ? undefined : unwrap(registry);
  if (owner === undefined || registryObject?.type !== "ObjectExpression") {
    return panic("Documentation waiver owner missing");
  }
  const property = (
    object: ObjectExpression,
    name: string,
  ): Expression | undefined => {
    for (const member of object.properties) {
      if (
        member.type === "Property" &&
        !member.method &&
        staticPropertyName(member) === name
      ) {
        return member.value;
      }
    }
    return undefined;
  };
  const dateSlot = (
    object: ObjectExpression,
    name: "checkedAt" | "expiresAt",
  ): StringLiteral | undefined => {
    const initializer = property(object, name);
    if (initializer === undefined) {
      return undefined;
    }
    const value = resolve(initializer);
    return value.type === "Literal" && typeof value.value === "string"
      ? value
      : panic(`Documentation waiver ${name} is not a string literal`);
  };
  const dateSlots = (object: ObjectExpression) => ({
    checkedAt: dateSlot(object, "checkedAt"),
    expiresAt: dateSlot(object, "expiresAt"),
  });
  const mapped = (
    call: CallExpression,
    receiver: Expression,
  ): DocumentationSite[] => {
    const items = resolve(receiver);
    const callback = call.arguments.at(0);
    if (
      items.type !== "ArrayExpression" ||
      callback === undefined ||
      callback.type === "SpreadElement"
    ) {
      return panic("Documentation waiver map has no literal dependency list");
    }
    const fn = resolve(callback);
    const object =
      fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement"
        ? unwrap(fn.body)
        : undefined;
    if (object?.type !== "ObjectExpression") {
      return panic("Documentation waiver map callback must return an object");
    }
    return items.elements.map((item) => {
      const name =
        item?.type === "ArrayExpression" ? item.elements.at(0) : item;
      if (!item || name?.type !== "Literal" || typeof name.value !== "string") {
        return panic("Documentation waiver map item has no dependency name");
      }
      return {
        dependency: name.value,
        node: item,
        declaration: fn,
        ...dateSlots(object),
      };
    });
  };
  const collect = (node: Expression): DocumentationSite[] => {
    const value = resolve(node);
    if (value.type === "ObjectExpression") {
      const dependency = property(value, "dependency");
      if (
        dependency?.type !== "Literal" ||
        typeof dependency.value !== "string"
      ) {
        return panic("Documentation waiver object has no literal dependency");
      }
      return [
        {
          dependency: dependency.value,
          node: value,
          declaration: value,
          ...dateSlots(value),
        },
      ];
    }
    if (value.type === "ArrayExpression") {
      return value.elements.flatMap((element) => {
        if (element === null) {
          return panic("Unsupported documentation waiver declaration shape");
        }
        return collect(
          element.type === "SpreadElement" ? element.argument : element,
        );
      });
    }
    if (
      value.type === "CallExpression" &&
      value.callee.type === "MemberExpression" &&
      !value.callee.computed &&
      value.callee.property.type === "Identifier"
    ) {
      const receiver = value.callee.object;
      switch (value.callee.property.name) {
        case "concat":
          return [
            ...collect(receiver),
            ...value.arguments.flatMap((argument) =>
              collect(
                argument.type === "SpreadElement"
                  ? argument.argument
                  : argument,
              ),
            ),
          ];
        case "map":
          return mapped(value, receiver);
        default:
          break;
      }
    }
    return panic("Unsupported documentation waiver declaration shape");
  };
  return { ast, registry: registryObject, sites: collect(owner) };
};

const baselineSchema = v.looseObject({
  accepted: v.array(v.looseObject({ id: v.string() })),
});
export const readAuditAcceptanceOwner = (source: string) =>
  v.parse(baselineSchema, JSON.parse(source));

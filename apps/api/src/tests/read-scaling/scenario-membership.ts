import { panic } from "better-result";
import path from "node:path";

import { type Expression, parseSource } from "@stll/scripts/src/syntax-tree";

type HandlerOwner = { file: string; exportName: string };

export type ScenarioMembership =
  | { kind: "api"; name: string; handlerOwner: HandlerOwner }
  | { kind: "mcp"; name: string };

type ImportBinding = { specifier: string; exportName: string };
type RegistryModule = {
  values: Map<string, Expression>;
  imports: Map<string, ImportBinding>;
};
type RegistryReader = {
  readSource: (file: string) => string;
  modules: Map<string, RegistryModule>;
};
type RegistryReference = { file: string; symbol: string };
type RegistryContext = {
  reader: RegistryReader;
  active: ReadonlySet<string>;
  kind: ScenarioMembership["kind"];
};
type RegistryExpression = { file: string; expression: Expression };

const unsupported = (detail: string): never =>
  panic(`Unsupported scaling scenario registry: ${detail}`);

const unwrap = (expression: Expression): Expression => {
  if (
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression"
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const moduleFile = ({
  file,
  specifier,
}: {
  file: string;
  specifier: string;
}) => {
  let resolved: string;
  if (specifier.startsWith("@/api/")) {
    resolved = `apps/api/src/${specifier.slice("@/api/".length)}`;
  } else if (specifier.startsWith(".")) {
    resolved = path.posix.join(path.posix.dirname(file), specifier);
  } else {
    return unsupported(`non-local module ${specifier}`);
  }
  const normalized = path.posix.normalize(resolved);
  if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return unsupported(`module escapes the repository: ${specifier}`);
  }
  return `${normalized.replace(/\.[cm]?[jt]sx?$/u, "")}.ts`;
};

const readModule = (reader: RegistryReader, file: string): RegistryModule => {
  const cached = reader.modules.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const { program } = parseSource(file, reader.readSource(file));
  const values = new Map<string, Expression>();
  const imports = new Map<string, ImportBinding>();
  const names = new Set<string>();
  const declare = (name: string) => {
    if (names.has(name)) {
      unsupported(`duplicate binding ${file}#${name}`);
    }
    names.add(name);
  };
  for (const statement of program.body) {
    const declared =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declared?.type === "VariableDeclaration") {
      for (const declaration of declared.declarations) {
        if (declaration.id.type !== "Identifier") {
          continue;
        }
        declare(declaration.id.name);
        if (declared.kind === "const" && declaration.init !== null) {
          values.set(declaration.id.name, declaration.init);
        }
      }
    }
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    const specifier = statement.source.value;
    const add = (name: string, exportName: string) => {
      declare(name);
      imports.set(name, { specifier, exportName });
    };
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportDefaultSpecifier") {
        add(binding.local.name, "default");
      } else if (binding.type === "ImportNamespaceSpecifier") {
        add(binding.local.name, "*");
      } else if (binding.importKind !== "type") {
        add(
          binding.local.name,
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value,
        );
      }
    }
  }
  const result = { values, imports };
  reader.modules.set(file, result);
  return result;
};

const enterReference = (
  reference: RegistryReference,
  context: RegistryContext,
): RegistryContext => {
  const key = `${reference.file}#${reference.symbol}`;
  if (context.active.has(key)) {
    return unsupported(`cyclic binding ${key}`);
  }
  return { ...context, active: new Set(context.active).add(key) };
};

const handlerOwner = (
  { file, expression }: RegistryExpression,
  context: RegistryContext,
): HandlerOwner => {
  const owner = unwrap(expression);
  const module = readModule(context.reader, file);
  if (owner.type === "Identifier") {
    const imported = module.imports.get(owner.name);
    if (imported !== undefined && imported.exportName !== "*") {
      return {
        file: moduleFile({ file, specifier: imported.specifier }),
        exportName: imported.exportName,
      };
    }
    const value = module.values.get(owner.name);
    if (value !== undefined) {
      return handlerOwner(
        { file, expression: value },
        enterReference({ file, symbol: owner.name }, context),
      );
    }
  }
  if (
    owner.type === "MemberExpression" &&
    !owner.computed &&
    owner.object.type === "Identifier" &&
    owner.property.type === "Identifier"
  ) {
    const imported = module.imports.get(owner.object.name);
    if (imported?.exportName === "*") {
      return {
        file: moduleFile({ file, specifier: imported.specifier }),
        exportName: owner.property.name,
      };
    }
  }
  return unsupported(`handler must name an imported owner in ${file}`);
};

const scenario = (
  { file, expression }: RegistryExpression,
  context: RegistryContext,
): ScenarioMembership => {
  if (expression.type !== "ObjectExpression") {
    return unsupported(`scenario must be a literal in ${file}`);
  }
  const properties = new Map<string, Expression>();
  for (const property of expression.properties) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method ||
      property.shorthand ||
      property.computed
    ) {
      return unsupported(`computed, spread or accessor scenario in ${file}`);
    }
    const { key } = property;
    let name: string;
    if (key.type === "Identifier") {
      name = key.name;
    } else if (key.type === "Literal" && typeof key.value === "string") {
      name = key.value;
    } else {
      return unsupported(`computed, spread or accessor scenario in ${file}`);
    }
    if (properties.has(name)) {
      return unsupported(`duplicate scenario property ${name} in ${file}`);
    }
    properties.set(name, property.value);
  }
  const name = properties.get("name");
  const literal = name === undefined ? undefined : unwrap(name);
  if (
    literal?.type !== "Literal" ||
    typeof literal.value !== "string" ||
    !properties.has("measure")
  ) {
    return unsupported(
      `scenario needs a literal name and measurement in ${file}`,
    );
  }
  const scenarioName = literal.value;
  if (context.kind === "mcp") {
    return { kind: "mcp", name: scenarioName };
  }
  const definition = properties.get("definition");
  if (definition !== undefined) {
    return {
      kind: "api",
      name: scenarioName,
      handlerOwner: handlerOwner(
        { file, expression: unwrap(definition) },
        context,
      ),
    };
  }
  // A base registry written before the HTTP core names `owner.handler`.
  const handler = properties.get("handler");
  const value = handler === undefined ? undefined : unwrap(handler);
  if (
    value?.type !== "MemberExpression" ||
    value.computed ||
    value.property.type !== "Identifier" ||
    value.property.name !== "handler"
  ) {
    return unsupported(
      `API scenario needs the imported owner's definition in ${file}`,
    );
  }
  return {
    kind: "api",
    name: scenarioName,
    handlerOwner: handlerOwner({ file, expression: value.object }, context),
  };
};

const resolveReference = (
  reference: RegistryReference,
  context: RegistryContext,
): ScenarioMembership[] => {
  const next = enterReference(reference, context);
  const module = readModule(context.reader, reference.file);
  const imported = module.imports.get(reference.symbol);
  if (imported !== undefined && imported.exportName !== "*") {
    return resolveReference(
      {
        file: moduleFile({
          file: reference.file,
          specifier: imported.specifier,
        }),
        symbol: imported.exportName,
      },
      next,
    );
  }
  const value = module.values.get(reference.symbol);
  if (value === undefined) {
    return unsupported(
      `missing immutable binding ${reference.file}#${reference.symbol}`,
    );
  }
  return resolveExpression({ file: reference.file, expression: value }, next);
};

const resolveExpression = (
  { file, expression }: RegistryExpression,
  context: RegistryContext,
): ScenarioMembership[] => {
  const value = unwrap(expression);
  if (value.type === "Identifier") {
    return resolveReference({ file, symbol: value.name }, context);
  }
  if (value.type === "ArrayExpression") {
    return value.elements.flatMap((element) => {
      if (element === null) {
        return unsupported(`sparse registry in ${file}`);
      }
      return resolveExpression(
        {
          file,
          expression:
            element.type === "SpreadElement" ? element.argument : element,
        },
        context,
      );
    });
  }
  return [scenario({ file, expression: value }, context)];
};

type ReadScenarioRegistryOptions = RegistryReference & {
  kind: ScenarioMembership["kind"];
  readSource: RegistryReader["readSource"];
};

/** Preserve the measured source identities without interpreting application routes. */
export const readScenarioRegistry = ({
  file,
  symbol,
  kind,
  readSource,
}: ReadScenarioRegistryOptions) => {
  const entries = resolveReference(
    { file, symbol },
    { reader: { readSource, modules: new Map() }, kind, active: new Set() },
  );
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    return unsupported(`duplicate scenario names in ${file}#${symbol}`);
  }
  return entries;
};

const membershipKey = (entry: ScenarioMembership) =>
  entry.kind === "api"
    ? JSON.stringify([
        entry.kind,
        entry.name,
        entry.handlerOwner.file,
        entry.handlerOwner.exportName,
      ])
    : JSON.stringify([entry.kind, entry.name]);

type ScenarioMembershipOptions = {
  base: readonly ScenarioMembership[];
  current: readonly ScenarioMembership[];
};

export const scenarioMembershipViolations = ({
  base,
  current,
}: ScenarioMembershipOptions) => {
  const retained = new Set(current.map(membershipKey));
  return base
    .filter((entry) => !retained.has(membershipKey(entry)))
    .map(
      (entry) =>
        `previously measured scenario removed: ${membershipKey(entry)}`,
    );
};

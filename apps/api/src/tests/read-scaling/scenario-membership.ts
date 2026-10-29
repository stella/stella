import { panic } from "better-result";
import path from "node:path";
import ts from "typescript6";

type HandlerOwner = { file: string; exportName: string };

export type ScenarioMembership =
  | { kind: "api"; name: string; handlerOwner: HandlerOwner }
  | { kind: "mcp"; name: string };

type ImportBinding = { specifier: string; exportName: string };
type RegistryModule = {
  values: Map<string, ts.Expression>;
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
type RegistryExpression = { file: string; expression: ts.Expression };

const unsupported = (detail: string): never =>
  panic(`Unsupported scaling scenario registry: ${detail}`);

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
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
  const source = ts.createSourceFile(
    file,
    reader.readSource(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const values = new Map<string, ts.Expression>();
  const imports = new Map<string, ImportBinding>();
  const names = new Set<string>();
  const declare = (name: string) => {
    if (names.has(name)) {
      unsupported(`duplicate binding ${file}#${name}`);
    }
    names.add(name);
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }
        declare(declaration.name.text);
        if (
          statement.declarationList.getFirstToken(source)?.kind ===
            ts.SyntaxKind.ConstKeyword &&
          declaration.initializer !== undefined
        ) {
          values.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (
      clause === undefined ||
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const add = (name: string, exportName: string) => {
      declare(name);
      imports.set(name, { specifier, exportName });
    };
    if (clause.name !== undefined) {
      add(clause.name.text, "default");
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      add(bindings.name.text, "*");
    } else if (bindings !== undefined) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) {
          add(
            binding.name.text,
            binding.propertyName?.text ?? binding.name.text,
          );
        }
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
  if (ts.isIdentifier(owner)) {
    const imported = module.imports.get(owner.text);
    if (imported !== undefined && imported.exportName !== "*") {
      return {
        file: moduleFile({ file, specifier: imported.specifier }),
        exportName: imported.exportName,
      };
    }
    const value = module.values.get(owner.text);
    if (value !== undefined) {
      return handlerOwner(
        { file, expression: value },
        enterReference({ file, symbol: owner.text }, context),
      );
    }
  }
  if (
    ts.isPropertyAccessExpression(owner) &&
    ts.isIdentifier(owner.expression)
  ) {
    const imported = module.imports.get(owner.expression.text);
    if (imported?.exportName === "*") {
      return {
        file: moduleFile({ file, specifier: imported.specifier }),
        exportName: owner.name.text,
      };
    }
  }
  return unsupported(`handler must name an imported owner in ${file}`);
};

const scenario = (
  { file, expression }: RegistryExpression,
  context: RegistryContext,
): ScenarioMembership => {
  if (!ts.isObjectLiteralExpression(expression)) {
    return unsupported(`scenario must be a literal in ${file}`);
  }
  const properties = new Map<string, ts.Expression>();
  for (const property of expression.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
    ) {
      return unsupported(`computed, spread or accessor scenario in ${file}`);
    }
    const name = property.name.text;
    if (properties.has(name)) {
      return unsupported(`duplicate scenario property ${name} in ${file}`);
    }
    properties.set(name, property.initializer);
  }
  const name = properties.get("name");
  const literal = name === undefined ? undefined : unwrap(name);
  if (
    literal === undefined ||
    !ts.isStringLiteral(literal) ||
    !properties.has("measure")
  ) {
    return unsupported(
      `scenario needs a literal name and measurement in ${file}`,
    );
  }
  if (context.kind === "mcp") {
    return { kind: "mcp", name: literal.text };
  }
  const definition = properties.get("definition");
  if (definition !== undefined) {
    return {
      kind: "api",
      name: literal.text,
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
    value === undefined ||
    !ts.isPropertyAccessExpression(value) ||
    value.name.text !== "handler"
  ) {
    return unsupported(
      `API scenario needs the imported owner's definition in ${file}`,
    );
  }
  return {
    kind: "api",
    name: literal.text,
    handlerOwner: handlerOwner({ file, expression: value.expression }, context),
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
  if (ts.isIdentifier(value)) {
    return resolveReference({ file, symbol: value.text }, context);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.flatMap((element) => {
      if (ts.isOmittedExpression(element)) {
        return unsupported(`sparse registry in ${file}`);
      }
      return resolveExpression(
        {
          file,
          expression: ts.isSpreadElement(element)
            ? element.expression
            : element,
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

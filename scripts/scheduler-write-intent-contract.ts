import { panic } from "better-result";

import {
  type Node,
  parseSource,
  type Program,
  staticPropertyName,
} from "../packages/scripts/src/syntax-tree";

const AUTHORITY_FILE = "apps/api/src/lib/scheduler/task-authority.ts";
const BOOKKEEPING_FILE =
  "apps/api/src/lib/db/recovery-bookkeeping/scheduler.ts";

type SchedulerOwnership = "organization" | "platform";
type SchedulerWriteIntentDisposition = SchedulerOwnership | "by-task";

const invalid = (message: string): never =>
  panic(`Invalid scheduler write-intent contract: ${message}`);

const unwrap = (node: Node): Node => {
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "ParenthesizedExpression"
  ) {
    return unwrap(node.expression);
  }
  return node;
};

const declarations = (program: Program): readonly Node[] =>
  program.body.map((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration !== null
      ? statement.declaration
      : statement,
  );

const exportedConstant = (program: Program, name: string): Node => {
  const initializers: Node[] = [];
  for (const statement of program.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== name
      ) {
        continue;
      }
      if (statement.declaration.kind !== "const" || declaration.init === null) {
        return invalid(`${name} must be an initialized exported const`);
      }
      initializers.push(declaration.init);
    }
  }
  const initializer = initializers.at(0);
  if (initializers.length !== 1 || initializer === undefined) {
    return invalid(`expected exactly one direct exported ${name}`);
  }
  return initializer;
};

const objectFields = (node: Node, label: string): ReadonlyMap<string, Node> => {
  const object = unwrap(node);
  if (object.type !== "ObjectExpression") {
    return invalid(`${label} must be a literal object`);
  }
  const fields = new Map<string, Node>();
  for (const property of object.properties) {
    if (
      property.type !== "Property" ||
      property.kind !== "init" ||
      property.method ||
      property.computed
    ) {
      return invalid(`${label} contains an unsupported property or spread`);
    }
    const name = staticPropertyName(property);
    if (name === undefined || name === "__proto__") {
      return invalid(`${label} requires static property names`);
    }
    if (fields.has(name)) {
      return invalid(`${label} contains duplicate field ${name}`);
    }
    fields.set(name, property.value);
  }
  return fields;
};

const ownershipLiteral = (
  node: Node | undefined,
  label: string,
): SchedulerOwnership => {
  if (node === undefined) {
    return invalid(`${label} is missing schedulerOwnership`);
  }
  const value = unwrap(node);
  if (
    value.type !== "Literal" ||
    (value.value !== "organization" && value.value !== "platform")
  ) {
    return invalid(
      `${label} requires an organization or platform ownership literal`,
    );
  }
  return value.value;
};

const validatePlatformHelper = (program: Program): void => {
  const initializers: Node[] = [];
  for (const declaration of declarations(program)) {
    if (declaration.type !== "VariableDeclaration") {
      continue;
    }
    for (const variable of declaration.declarations) {
      if (
        variable.id.type !== "Identifier" ||
        variable.id.name !== "platform"
      ) {
        continue;
      }
      if (declaration.kind !== "const" || variable.init === null) {
        return invalid("platform must be a local const helper");
      }
      initializers.push(variable.init);
    }
  }
  const initializer = initializers.at(0);
  if (initializers.length !== 1 || initializer === undefined) {
    return invalid("missing unique local platform helper");
  }
  const fn = unwrap(initializer);
  if (
    fn.type !== "ArrowFunctionExpression" ||
    fn.async ||
    fn.params.length !== 2 ||
    fn.params.some((parameter) => parameter.type !== "Identifier")
  ) {
    return invalid("unsupported platform helper form");
  }
  let body: Node = fn.body;
  if (body.type === "BlockStatement") {
    const statement = body.body.at(0);
    if (
      body.body.length !== 1 ||
      statement?.type !== "ReturnStatement" ||
      statement.argument === null
    ) {
      return invalid("platform helper must directly return its literal object");
    }
    body = statement.argument;
  }
  const fields = objectFields(body, "platform helper return");
  if (
    ownershipLiteral(
      fields.get("schedulerOwnership"),
      "platform helper return",
    ) !== "platform"
  ) {
    return invalid("platform helper must return literal platform ownership");
  }
};

/** Read the measured tree's declaration; never import the live runtime registry. */
export const parseSchedulerTaskOwnership = (
  sourceText: string,
): ReadonlyMap<string, SchedulerOwnership> => {
  const program = parseSource(AUTHORITY_FILE, sourceText).program;
  const entries = objectFields(
    exportedConstant(program, "SCHEDULER_TASK_AUTHORITY"),
    "SCHEDULER_TASK_AUTHORITY",
  );
  if (entries.size === 0) {
    return invalid("SCHEDULER_TASK_AUTHORITY must not be empty");
  }
  const result = new Map<string, SchedulerOwnership>();
  let platformVerified = false;
  for (const [task, initializer] of entries) {
    const value = unwrap(initializer);
    if (value.type === "ObjectExpression") {
      const fields = objectFields(value, `task ${task}`);
      result.set(
        task,
        ownershipLiteral(fields.get("schedulerOwnership"), `task ${task}`),
      );
      continue;
    }
    if (
      value.type !== "CallExpression" ||
      value.callee.type !== "Identifier" ||
      value.callee.name !== "platform" ||
      value.optional ||
      (value.typeArguments !== null && value.typeArguments !== undefined) ||
      value.arguments.length !== 2 ||
      value.arguments.some((argument) => {
        const literal = unwrap(argument);
        return literal.type !== "Literal" || typeof literal.value !== "string";
      })
    ) {
      return invalid(
        `task ${task} requires an inline ownership object or canonical platform call`,
      );
    }
    if (!platformVerified) {
      validatePlatformHelper(program);
      platformVerified = true;
    }
    result.set(task, "platform");
  }
  return result;
};

const typeAliases = (program: Program): ReadonlyMap<string, Node> => {
  const aliases = new Map<string, Node>();
  for (const declaration of declarations(program)) {
    if (declaration.type !== "TSTypeAliasDeclaration") {
      continue;
    }
    if (aliases.has(declaration.id.name)) {
      return invalid(`duplicate type alias ${declaration.id.name}`);
    }
    aliases.set(declaration.id.name, declaration);
  }
  return aliases;
};

type SourceTypeContext = {
  node: Node;
  aliases: ReadonlyMap<string, Node>;
  visiting?: ReadonlySet<string>;
};

const literalTypes = ({
  node,
  aliases,
  visiting = new Set<string>(),
}: SourceTypeContext): readonly string[] => {
  if (node.type === "TSParenthesizedType") {
    return literalTypes({ node: node.typeAnnotation, aliases, visiting });
  }
  if (node.type === "TSTypeReference") {
    if (node.typeName.type !== "Identifier" || node.typeArguments !== null) {
      return invalid("unsupported literal type reference");
    }
    const name = node.typeName.name;
    if (visiting.has(name)) {
      return invalid(`cyclic literal type alias ${name}`);
    }
    const declaration = aliases.get(name);
    if (
      declaration?.type !== "TSTypeAliasDeclaration" ||
      declaration.typeParameters !== null
    ) {
      return invalid(`unresolved local literal type alias ${name}`);
    }
    return literalTypes({
      node: declaration.typeAnnotation,
      aliases,
      visiting: new Set([...visiting, name]),
    });
  }
  if (node.type === "TSUnionType") {
    return node.types.flatMap((part) =>
      literalTypes({ node: part, aliases, visiting }),
    );
  }
  if (
    node.type === "TSLiteralType" &&
    node.literal.type === "Literal" &&
    typeof node.literal.value === "string"
  ) {
    return [node.literal.value];
  }
  return invalid(
    "operation discriminators and disposition types must be string literals",
  );
};

type SourceFieldContext = SourceTypeContext & {
  field: "type" | "table";
  read: (node: Node) => readonly string[];
};

const mergeBranches = ({
  left,
  right,
  field,
}: {
  left: readonly (string | undefined)[];
  right: readonly (string | undefined)[];
  field: SourceFieldContext["field"];
}): readonly (string | undefined)[] => {
  const result: (string | undefined)[] = [];
  for (const first of left) {
    for (const second of right) {
      if (first !== undefined && second !== undefined && first !== second) {
        return invalid(
          field === "type"
            ? "conflicting operation type discriminators"
            : "different scheduler write tables in an intersection",
        );
      }
      result.push(first ?? second);
      if (result.length > 128) {
        return invalid("operation branch domain exceeds 128");
      }
    }
  }
  return result;
};

const sourceFieldBranches = (
  context: SourceFieldContext,
): readonly (string | undefined)[] => {
  const { node, aliases, field, read, visiting = new Set<string>() } = context;
  if (node.type === "TSParenthesizedType") {
    return sourceFieldBranches({ ...context, node: node.typeAnnotation });
  }
  if (node.type === "TSTypeReference") {
    if (node.typeName.type !== "Identifier" || node.typeArguments !== null) {
      return invalid("unsupported operation type reference");
    }
    const name = node.typeName.name;
    if (visiting.has(name)) {
      return invalid(`cyclic operation type alias ${name}`);
    }
    const declaration = aliases.get(name);
    if (
      declaration?.type !== "TSTypeAliasDeclaration" ||
      declaration.typeParameters !== null
    ) {
      return invalid(`unresolved local operation type alias ${name}`);
    }
    return sourceFieldBranches({
      ...context,
      node: declaration.typeAnnotation,
      visiting: new Set([...visiting, name]),
    });
  }
  if (node.type === "TSUnionType") {
    return node.types.flatMap((part) =>
      sourceFieldBranches({ ...context, node: part }),
    );
  }
  if (node.type === "TSIntersectionType") {
    let branches: readonly (string | undefined)[] = [undefined];
    for (const part of node.types) {
      branches = mergeBranches({
        left: branches,
        right: sourceFieldBranches({ ...context, node: part }),
        field,
      });
    }
    return branches;
  }
  if (node.type !== "TSTypeLiteral") {
    return invalid(`unsupported operation type form ${node.type}`);
  }
  const seen = new Set<string>();
  let annotation: Node | undefined;
  for (const member of node.members) {
    if (member.type !== "TSPropertySignature" || member.computed) {
      return invalid("operation type requires static property signatures");
    }
    const name = staticPropertyName(member);
    if (name === undefined || seen.has(name)) {
      return invalid("operation type contains an unknown or duplicate field");
    }
    seen.add(name);
    if (name === field) {
      if (member.optional || member.typeAnnotation === null) {
        return invalid(
          field === "type"
            ? "operation type requires a mandatory type discriminator"
            : "scheduler operation requires a mandatory table field",
        );
      }
      annotation = member.typeAnnotation.typeAnnotation;
    }
  }
  return annotation === undefined ? [undefined] : read(annotation);
};

const operationBranches = (
  context: SourceTypeContext,
): readonly (string | undefined)[] =>
  sourceFieldBranches({
    ...context,
    field: "type",
    read: (node) => literalTypes({ node, aliases: context.aliases }),
  });

const hasRecordShadow = (program: Program): boolean =>
  declarations(program).some((declaration) => {
    if (declaration.type === "ImportDeclaration") {
      return declaration.specifiers.some(
        ({ local }) => local.name === "Record",
      );
    }
    if (
      declaration.type === "TSTypeAliasDeclaration" ||
      declaration.type === "TSInterfaceDeclaration" ||
      declaration.type === "ClassDeclaration" ||
      declaration.type === "FunctionDeclaration"
    ) {
      return declaration.id?.name === "Record";
    }
    return (
      declaration.type === "VariableDeclaration" &&
      declaration.declarations.some(
        ({ id }) => id.type === "Identifier" && id.name === "Record",
      )
    );
  });

const concreteWriterOperation = (program: Program) => {
  const implementations = declarations(program).filter(
    (declaration) =>
      declaration.type === "FunctionDeclaration" &&
      declaration.id?.name === "writeSchedulerBookkeeping" &&
      declaration.body !== null,
  );
  const implementation = implementations.at(0);
  if (
    implementations.length !== 1 ||
    implementation?.type !== "FunctionDeclaration" ||
    implementation.params.length !== 1
  ) {
    return invalid(
      "missing unique concrete writeSchedulerBookkeeping implementation",
    );
  }
  const parameter = implementation.params.at(0);
  const annotation =
    parameter?.type === "Identifier"
      ? parameter.typeAnnotation?.typeAnnotation
      : undefined;
  if (
    annotation?.type !== "TSTypeReference" ||
    annotation.typeName.type !== "Identifier" ||
    annotation.typeArguments !== null
  ) {
    return invalid(
      "intent map must classify the concrete writer's operation type",
    );
  }
  return { node: annotation, name: annotation.typeName.name };
};

const contractOperationType = (initializer: Node, program: Program): Node => {
  if (initializer.type !== "TSSatisfiesExpression") {
    return invalid(
      "intent map requires as const satisfies Record<Operation['type'], ...>",
    );
  }
  const constant = initializer.expression;
  if (
    constant.type !== "TSAsExpression" ||
    constant.typeAnnotation.type !== "TSTypeReference" ||
    constant.typeAnnotation.typeName.type !== "Identifier" ||
    constant.typeAnnotation.typeName.name !== "const" ||
    constant.typeAnnotation.typeArguments !== null
  ) {
    return invalid("intent map requires an as const literal declaration");
  }
  const contract = initializer.typeAnnotation;
  if (
    contract.type !== "TSTypeReference" ||
    contract.typeName.type !== "Identifier" ||
    contract.typeName.name !== "Record" ||
    hasRecordShadow(program) ||
    contract.typeArguments?.params.length !== 2
  ) {
    return invalid("intent map requires the global total Record type");
  }
  const key = contract.typeArguments.params.at(0);
  if (
    key?.type !== "TSIndexedAccessType" ||
    key.objectType.type !== "TSTypeReference" ||
    key.objectType.typeName.type !== "Identifier" ||
    key.objectType.typeArguments !== null ||
    key.indexType.type !== "TSLiteralType" ||
    key.indexType.literal.type !== "Literal" ||
    key.indexType.literal.value !== "type"
  ) {
    return invalid("intent map Record keys must derive from Operation['type']");
  }
  const value = contract.typeArguments.params.at(1);
  if (value === undefined) {
    return invalid("missing intent map disposition type");
  }
  const allowed = new Set(
    literalTypes({ node: value, aliases: typeAliases(program) }),
  );
  if (
    allowed.size !== 3 ||
    !allowed.has("organization") ||
    !allowed.has("platform") ||
    !allowed.has("by-task")
  ) {
    return invalid(
      "intent map disposition type must be organization | platform | by-task",
    );
  }
  const writer = concreteWriterOperation(program);
  if (writer.name !== key.objectType.typeName.name) {
    return invalid(
      "intent map must classify the concrete writer's operation type",
    );
  }
  return key.objectType;
};

/** Require exact keys from the measured writer's operation union, in both directions. */
export const parseSchedulerWriteIntentDispositions = (
  sourceText: string,
): ReadonlyMap<string, SchedulerWriteIntentDisposition> => {
  const program = parseSource(BOOKKEEPING_FILE, sourceText).program;
  const initializer = exportedConstant(
    program,
    "SCHEDULER_WRITE_INTENT_DISPOSITIONS",
  );
  const operationType = contractOperationType(initializer, program);
  const branches = operationBranches({
    node: operationType,
    aliases: typeAliases(program),
  });
  if (
    branches.length === 0 ||
    branches.some((branch) => branch === undefined)
  ) {
    return invalid("every operation branch must declare a type discriminator");
  }
  const operations = new Set(branches);
  const fields = objectFields(
    initializer,
    "SCHEDULER_WRITE_INTENT_DISPOSITIONS",
  );
  const result = new Map<string, SchedulerWriteIntentDisposition>();
  for (const [operation, node] of fields) {
    if (!operations.has(operation)) {
      return invalid(`unexpected intent disposition ${operation}`);
    }
    const value = unwrap(node);
    if (
      value.type !== "Literal" ||
      (value.value !== "organization" &&
        value.value !== "platform" &&
        value.value !== "by-task")
    ) {
      return invalid(
        `operation ${operation} requires a literal intent disposition`,
      );
    }
    result.set(operation, value.value);
  }
  for (const operation of operations) {
    if (operation === undefined) {
      return invalid("missing intent disposition for an unnamed operation");
    }
    if (!result.has(operation)) {
      return invalid(`missing intent disposition ${operation}`);
    }
  }
  return result;
};

const bindsValueName = (pattern: Node, name: string): boolean => {
  if (pattern.type === "Identifier") {
    return pattern.name === name;
  }
  if (pattern.type === "AssignmentPattern") {
    return bindsValueName(pattern.left, name);
  }
  if (pattern.type === "RestElement") {
    return bindsValueName(pattern.argument, name);
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.some(
      (element) => element !== null && bindsValueName(element, name),
    );
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.some((property) =>
      bindsValueName(
        property.type === "RestElement" ? property.argument : property.value,
        name,
      ),
    );
  }
  return false;
};

const hasSchemaValueShadow = (program: Program, name: string): boolean =>
  declarations(program).some((declaration) => {
    if (declaration.type === "VariableDeclaration") {
      return declaration.declarations.some(({ id }) =>
        bindsValueName(id, name),
      );
    }
    if (
      declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration" ||
      declaration.type === "TSEnumDeclaration" ||
      declaration.type === "TSImportEqualsDeclaration"
    ) {
      return declaration.id?.name === name;
    }
    if (declaration.type === "TSModuleDeclaration") {
      return (
        declaration.id.type === "Identifier" && declaration.id.name === name
      );
    }
    return false;
  });

const tableSchemaExport = (node: Node, program: Program): string => {
  if (node.type === "TSParenthesizedType") {
    return tableSchemaExport(node.typeAnnotation, program);
  }
  if (
    node.type !== "TSTypeQuery" ||
    node.exprName.type !== "Identifier" ||
    node.typeArguments !== null
  ) {
    return invalid(
      "scheduler table field requires typeof a named schema import",
    );
  }
  const name = node.exprName.name;
  let exportName: string | undefined;
  let bindings = 0;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.local.name !== name) {
        continue;
      }
      bindings += 1;
      if (
        statement.source.value !== "@/api/db/schema" ||
        specifier.type !== "ImportSpecifier"
      ) {
        return invalid(
          `table ${name} requires a named canonical schema import`,
        );
      }
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      if (imported === "default") {
        return invalid(
          `table ${name} requires a named canonical schema export`,
        );
      }
      exportName = imported;
    }
  }
  if (bindings !== 1 || exportName === undefined) {
    return invalid(`unclassified or ambiguous schema import for table ${name}`);
  }
  if (hasSchemaValueShadow(program, name)) {
    return invalid(`shadowed schema import for table ${name}`);
  }
  return exportName;
};

/** Derive the common write target from the measured writer, including historical owners without intent metadata. */
export const parseSchedulerWriteTable = (sourceText: string): string => {
  const program = parseSource(BOOKKEEPING_FILE, sourceText).program;
  const writer = concreteWriterOperation(program);
  const branches = sourceFieldBranches({
    node: writer.node,
    aliases: typeAliases(program),
    field: "table",
    read: (node) => [tableSchemaExport(node, program)],
  });
  if (branches.length === 0 || branches.some((table) => table === undefined)) {
    return invalid(
      "every scheduler operation branch must declare a common mandatory table",
    );
  }
  const table = branches.at(0);
  if (
    table === undefined ||
    branches.some((candidate) => candidate !== table)
  ) {
    return invalid(
      "different scheduler write tables across operation branches",
    );
  }
  return table;
};

import { panic } from "better-result";

import {
  parseSource,
  staticPropertyName,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";
import type { Node } from "../packages/scripts/src/syntax-tree.ts";
import { parseGlobalSystemWorkOwners } from "./global-system-work-census.ts";
import { scopeTableExportNames } from "./root-connection-shapes.ts";
import type { SchedulerWriteGraphContract } from "./root-connection-shapes.ts";
import {
  parseSchedulerTaskOwnership,
  parseSchedulerWriteIntentDispositions,
  parseSchedulerWriteTable,
} from "./scheduler-write-intent-contract.ts";

const recoveryOwnerPath = "scripts/ownership/recovery-bookkeeping.ts";
const scopeRegistryPath = "apps/api/src/db/org-scope-registry.ts";
const rootOwnershipDirectory = "scripts/ownership/";
const unwrap = (node: Node): Node => {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
};

const stringLiteral = (node: Node | null | undefined): string | undefined =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

const memberName = (node: Node): string | undefined => {
  if (node.type !== "MemberExpression") {
    return undefined;
  }
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.computed ? stringLiteral(node.property) : undefined;
};

const literalProperty = (
  properties: readonly Node[],
  name: string,
  file: string,
): Node | undefined => {
  const matching = properties.filter(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      !property.method &&
      property.kind === "init" &&
      staticPropertyName(property) === name,
  );
  if (matching.length > 1) {
    return panic(`${file} repeats ownership property ${name}`);
  }
  return matching.at(0);
};

const recoveryClassNames = (
  source: ReturnType<typeof parseSource>,
  file: string,
): string[] => {
  const declarations = source.program.body.flatMap((statement) =>
    statement.type === "VariableDeclaration" && statement.kind === "const"
      ? statement.declarations.filter(
          (declaration) =>
            declaration.id.type === "Identifier" &&
            declaration.id.name === "CLASSES",
        )
      : [],
  );
  if (declarations.length !== 1) {
    return panic(`${file} must declare one literal recovery CLASSES array`);
  }
  const initializer = declarations.at(0)?.init;
  const classes =
    initializer === null || initializer === undefined
      ? undefined
      : unwrap(initializer);
  if (classes?.type !== "ArrayExpression") {
    return panic(`${file} recovery CLASSES must be an array literal`);
  }
  const names = classes.elements.map((element) => {
    const name = element === null ? undefined : stringLiteral(element);
    return (
      name ?? panic(`${file} recovery CLASSES entries must be string literals`)
    );
  });
  if (new Set(names).size !== names.length) {
    return panic(`${file} recovery CLASSES contains duplicate owners`);
  }
  return names;
};

const recoveryMappedOwnerPrefix = (ownerValue: Node, file: string): string => {
  if (ownerValue.type !== "CallExpression") {
    return panic(`${file} recovery owner must map its literal CLASSES`);
  }
  const mapCall = unwrap(ownerValue.callee);
  const mapper = ownerValue.arguments.at(0);
  const mapperParameter =
    mapper?.type === "ArrowFunctionExpression"
      ? mapper.params.at(0)
      : undefined;
  const mapperBody =
    mapper?.type === "ArrowFunctionExpression" ? mapper.body : undefined;
  const mapperExpression =
    mapperBody?.type === "TemplateLiteral"
      ? mapperBody.expressions.at(0)
      : undefined;
  if (
    mapCall.type !== "MemberExpression" ||
    memberName(mapCall) !== "map" ||
    mapCall.object.type !== "Identifier" ||
    mapCall.object.name !== "CLASSES" ||
    mapper?.type !== "ArrowFunctionExpression" ||
    mapper.params.length !== 1 ||
    mapperParameter?.type !== "Identifier" ||
    mapperBody?.type !== "TemplateLiteral" ||
    mapperBody.expressions.length !== 1 ||
    mapperExpression?.type !== "Identifier" ||
    mapperExpression.name !== mapperParameter.name
  ) {
    return panic(
      `${file} recovery owner mapping must interpolate its CLASSES parameter`,
    );
  }
  const prefix = mapperBody.quasis.at(0)?.value.cooked;
  const suffix = mapperBody.quasis.at(1)?.value.cooked;
  if (
    prefix !== "apps/api/src/lib/db/recovery-bookkeeping/" ||
    suffix !== ".ts"
  ) {
    return panic(`${file} recovery owner mapping changed its canonical path`);
  }
  return prefix;
};

const recoveryOwnerPrefix = (
  source: ReturnType<typeof parseSource>,
  file: string,
): string => {
  const defaults = source.program.body.filter(
    (statement) => statement.type === "ExportDefaultDeclaration",
  );
  const defaultExport = defaults.at(0);
  const record =
    defaultExport === undefined ? undefined : unwrap(defaultExport.declaration);
  if (defaults.length !== 1 || record?.type !== "ObjectExpression") {
    return panic(`${file} must export one literal recovery ownership record`);
  }
  const id = literalProperty(record.properties, "id", file);
  const idValue = id?.type === "Property" ? stringLiteral(id.value) : undefined;
  if (idValue !== "recovery-bookkeeping") {
    return panic(`${file} does not declare the recovery-bookkeeping owner`);
  }
  const owner = literalProperty(record.properties, "owner", file);
  const ownerValue =
    owner?.type === "Property" ? unwrap(owner.value) : undefined;
  if (
    ownerValue?.type !== "CallExpression" ||
    ownerValue.arguments.length !== 1
  ) {
    return panic(`${file} recovery owner must map its literal CLASSES`);
  }
  return recoveryMappedOwnerPrefix(ownerValue, file);
};

export const parseRecoveryOwnerFiles = (
  content: string,
  file = recoveryOwnerPath,
): ReadonlySet<string> => {
  const source = parseSource(file, content);
  const classNames = recoveryClassNames(source, file);
  const prefix = recoveryOwnerPrefix(source, file);
  return new Set(classNames.map((name) => `${prefix}${name}.ts`));
};

export const parseRootConnectionDoorFiles = (
  ownershipSources: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
  if (ownershipSources.size === 0) {
    return panic("The measured tree has no ownership source modules");
  }
  const owners = new Set<string>();
  for (const [file, content] of ownershipSources) {
    if (!file.startsWith(rootOwnershipDirectory)) {
      return panic(`Unexpected ownership source path ${file}`);
    }
    const source = parseSource(file, content);
    const defaults = source.program.body.filter(
      (statement) => statement.type === "ExportDefaultDeclaration",
    );
    const defaultExport = defaults.at(0);
    const record =
      defaultExport === undefined
        ? undefined
        : unwrap(defaultExport.declaration);
    if (defaults.length !== 1 || record?.type !== "ObjectExpression") {
      return panic(`${file} must export one literal ownership record`);
    }
    if (
      record.properties.some(
        (property) =>
          property.type !== "Property" ||
          property.computed ||
          property.method ||
          property.kind !== "init" ||
          staticPropertyName(property) === undefined,
      )
    ) {
      return panic(
        `${file} ownership records must use explicit literal fields`,
      );
    }
    const groupProperty = literalProperty(record.properties, "group", file);
    if (groupProperty === undefined) {
      continue;
    }
    if (groupProperty.type !== "Property") {
      return panic(`${file} ownership group must be literal`);
    }
    const group = stringLiteral(groupProperty.value);
    if (group === undefined) {
      return panic(`${file} ownership group must be a string literal`);
    }
    if (group !== "root-connection") {
      continue;
    }
    const idProperty = literalProperty(record.properties, "id", file);
    if (
      idProperty?.type !== "Property" ||
      stringLiteral(idProperty.value) === undefined
    ) {
      return panic(`${file} root-connection id must be a string literal`);
    }
    const ownerProperty = literalProperty(record.properties, "owner", file);
    if (ownerProperty?.type !== "Property") {
      return panic(`${file} root-connection owner must be an array literal`);
    }
    const ownerArray = unwrap(ownerProperty.value);
    if (ownerArray.type !== "ArrayExpression") {
      return panic(`${file} root-connection owner must be an array literal`);
    }
    const paths = ownerArray.elements.map((element) => {
      const owner = element === null ? undefined : stringLiteral(element);
      return (
        owner ?? panic(`${file} root-connection owners must be literal paths`)
      );
    });
    if (new Set(paths).size !== paths.length) {
      return panic(`${file} repeats a root-connection owner path`);
    }
    for (const owner of paths) {
      owners.add(owner);
    }
  }
  if (owners.size === 0) {
    return panic("The measured tree declares no root-connection owners");
  }
  return owners;
};

const schedulerWriteOwnerPaths = {
  bookkeeping: "apps/api/src/lib/db/recovery-bookkeeping/scheduler.ts",
  authority: "apps/api/src/lib/scheduler/task-authority.ts",
  global: "apps/api/src/lib/db/global-system-work.ts",
} as const;

type MixedSchedulerDescriptor = {
  table: string;
  ownerFile: string;
  authorityFile: string;
  globalOwnerFile: string;
};

const explicitFields = (
  node: Node,
  label: string,
): ReadonlyMap<string, Node> => {
  const object = unwrap(node);
  if (object.type !== "ObjectExpression") {
    return panic(`${label} must be a literal object`);
  }
  const fields = new Map<string, Node>();
  for (const property of object.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.shorthand ||
      property.kind !== "init"
    ) {
      return panic(`${label} must use explicit literal fields`);
    }
    const name = staticPropertyName(property);
    if (name === undefined || name === "__proto__" || fields.has(name)) {
      return panic(`${label} contains an unknown or duplicate field`);
    }
    fields.set(name, property.value);
  }
  return fields;
};

const exportedFields = ({
  content,
  file,
  name,
}: {
  content: string;
  file: string;
  name: string;
}): ReadonlyMap<string, Node> => {
  const program = parseSource(file, content).program;
  const declarations = program.body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration" &&
    statement.declaration.kind === "const"
      ? statement.declaration.declarations.filter(
          (declaration) =>
            declaration.id.type === "Identifier" &&
            declaration.id.name === name,
        )
      : [],
  );
  const initializer = declarations.at(0)?.init;
  if (
    declarations.length !== 1 ||
    initializer === undefined ||
    initializer === null
  ) {
    return panic(`${file} must export one literal ${name}`);
  }
  return explicitFields(initializer, name);
};

const requireFields = (
  fields: ReadonlyMap<string, Node>,
  names: readonly string[],
  label: string,
): void => {
  if (fields.size !== names.length || names.some((name) => !fields.has(name))) {
    return panic(`${label} has missing or unknown fields`);
  }
};

const mixedSchedulerDescriptor = (
  registry: string,
): MixedSchedulerDescriptor | undefined => {
  const rows = exportedFields({
    content: registry,
    file: scopeRegistryPath,
    name: "GLOBAL_SCOPE_TABLES",
  });
  let descriptor: MixedSchedulerDescriptor | undefined;
  for (const [table, node] of rows) {
    const fields = explicitFields(node, `GLOBAL_SCOPE_TABLES.${table}`);
    const ownershipNode = fields.get("ownership");
    const ownership = stringLiteral(ownershipNode);
    if (ownershipNode === undefined && !fields.has("writeOwner")) {
      continue;
    }
    if (ownership !== "mixed") {
      if (
        fields.has("writeOwner") ||
        (ownership !== "public-corpus" &&
          ownership !== "account" &&
          ownership !== "system")
      ) {
        return panic(
          `GLOBAL_SCOPE_TABLES.${table} has unknown ownership or misplaced writeOwner metadata`,
        );
      }
      continue;
    }
    if (descriptor !== undefined) {
      return panic("Only one mixed scheduler descriptor may be enrolled");
    }
    requireFields(
      fields,
      ["table", "ownership", "reason", "writeOwner"],
      `Mixed table ${table}`,
    );
    const actualTable = fields.get("table");
    if (actualTable?.type !== "Identifier" || actualTable.name !== table) {
      return panic(
        `Mixed table ${table} must match its descriptor.table export`,
      );
    }
    if (stringLiteral(fields.get("reason")) === undefined) {
      return panic(`Mixed table ${table} requires a literal reason`);
    }
    const ownerNode = fields.get("writeOwner");
    if (ownerNode === undefined) {
      return panic(`Mixed table ${table} is missing writeOwner`);
    }
    const owner = explicitFields(ownerNode, `Mixed table ${table}.writeOwner`);
    requireFields(
      owner,
      ["type", "bookkeeping", "authority", "global"],
      `Mixed table ${table}.writeOwner`,
    );
    if (stringLiteral(owner.get("type")) !== "scheduler") {
      return panic(`Mixed table ${table} has an unlisted writeOwner type`);
    }
    for (const [kind, path] of Object.entries(schedulerWriteOwnerPaths)) {
      if (stringLiteral(owner.get(kind)) !== path) {
        return panic(`Mixed table ${table} has an unknown ${kind} owner path`);
      }
    }
    descriptor = {
      table,
      ownerFile: schedulerWriteOwnerPaths.bookkeeping,
      authorityFile: schedulerWriteOwnerPaths.authority,
      globalOwnerFile: schedulerWriteOwnerPaths.global,
    };
  }
  return descriptor;
};

const declaresSchedulerIntents = (content: string): boolean => {
  const program = parseSource(
    schedulerWriteOwnerPaths.bookkeeping,
    content,
  ).program;
  let declared = false;
  walk(program, (node) => {
    if (
      node.type === "Identifier" &&
      node.name === "SCHEDULER_WRITE_INTENT_DISPOSITIONS"
    ) {
      declared = true;
    }
  });
  for (const statement of program.body) {
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.specifiers.some(
        ({ exported }) =>
          (exported.type === "Identifier" ? exported.name : exported.value) ===
          "SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      )
    ) {
      return true;
    }
    if (
      statement.type === "ExportAllDeclaration" &&
      statement.exportKind !== "type"
    ) {
      return panic(
        "Scheduler intent owner cannot forward unknown runtime exports",
      );
    }
  }
  return declared;
};

const emptySchedulerContract = (
  descriptor: MixedSchedulerDescriptor,
): SchedulerWriteGraphContract => ({
  table: descriptor.table,
  ownerFile: descriptor.ownerFile,
  globalOwnerFile: descriptor.globalOwnerFile,
  dispositions: new Map(),
  taskOwnership: new Map(),
  globalJobs: new Map(),
});

const schedulerWriteGraphContract = ({
  registry,
  sources,
  orgTables,
  globalTables,
  role,
}: {
  registry: string;
  sources: ReadonlyMap<string, string>;
  orgTables: ReadonlySet<string>;
  globalTables: ReadonlySet<string>;
  role: OrgWriteGraphMeasurementRole;
}): SchedulerWriteGraphContract | undefined => {
  const descriptor = mixedSchedulerDescriptor(registry);
  const ownerSource = sources.get(schedulerWriteOwnerPaths.bookkeeping);
  const declared =
    ownerSource !== undefined && declaresSchedulerIntents(ownerSource);
  // The inverse is required: removing the mixed row cannot disable an actual
  // typed intent owner's table constraint or turn it into a pure global table.
  const dispositions = declared
    ? parseSchedulerWriteIntentDispositions(ownerSource)
    : undefined;
  const writtenTable = declared
    ? parseSchedulerWriteTable(ownerSource)
    : undefined;
  if (
    writtenTable !== undefined &&
    (descriptor === undefined || descriptor.table !== writtenTable)
  ) {
    return panic(
      `Typed scheduler intent owner requires a matching mixed GLOBAL_SCOPE_TABLES descriptor for ${writtenTable}`,
    );
  }
  if (descriptor === undefined) {
    return undefined;
  }
  if (!globalTables.has(descriptor.table) || orgTables.has(descriptor.table)) {
    return panic(
      `Mixed scheduler table ${descriptor.table} must be registered exclusively in GLOBAL_SCOPE_TABLES`,
    );
  }
  if (ownerSource === undefined) {
    if (role === "head") {
      return panic(`Missing mixed scheduler source ${descriptor.ownerFile}`);
    }
    return emptySchedulerContract(descriptor);
  }
  const ownerTable = writtenTable ?? parseSchedulerWriteTable(ownerSource);
  if (ownerTable !== descriptor.table) {
    return panic(
      `Mixed scheduler table ${descriptor.table} disagrees with owner table ${ownerTable}`,
    );
  }
  if (dispositions === undefined) {
    if (role === "head") {
      return panic(
        "HEAD mixed scheduler owner is missing SCHEDULER_WRITE_INTENT_DISPOSITIONS",
      );
    }
    return emptySchedulerContract(descriptor);
  }
  const authoritySource =
    sources.get(descriptor.authorityFile) ??
    panic(`Missing mixed scheduler source ${descriptor.authorityFile}`);
  const globalSource =
    sources.get(descriptor.globalOwnerFile) ??
    panic(`Missing mixed scheduler source ${descriptor.globalOwnerFile}`);
  const globalOwners = parseGlobalSystemWorkOwners(
    globalSource,
    descriptor.globalOwnerFile,
  );
  return {
    table: descriptor.table,
    ownerFile: descriptor.ownerFile,
    globalOwnerFile: descriptor.globalOwnerFile,
    dispositions,
    taskOwnership: parseSchedulerTaskOwnership(authoritySource),
    globalJobs: new Map(
      Object.entries(globalOwners).map(([type, { owner }]) => [type, owner]),
    ),
  };
};

export type OrgWriteGraphMeasurementRole = "head" | "base";

/** The committed map of each schema table export to its SQL relation name. */
export const tableRelationsPath = "apps/api/src/lib/db/table-relations.gen.ts";

/** Reads `TABLE_RELATIONS` from the generated map; any other shape is fatal. */
export const parseTableRelations = (
  content: string,
): ReadonlyMap<string, string> => {
  const program = parseSource(tableRelationsPath, content).program;
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
        declaration.id.name !== "TABLE_RELATIONS" ||
        declaration.init === null
      ) {
        continue;
      }
      const map = unwrap(declaration.init);
      if (map.type !== "ObjectExpression") {
        return panic(`${tableRelationsPath} TABLE_RELATIONS must be literal`);
      }
      const relations = new Map<string, string>();
      for (const property of map.properties) {
        const table =
          property.type === "Property" &&
          !property.computed &&
          !property.method &&
          property.kind === "init"
            ? staticPropertyName(property)
            : undefined;
        const relation =
          property.type === "Property" ? stringLiteral(property.value) : "";
        if (table === undefined || relation === undefined) {
          return panic(
            `${tableRelationsPath} TABLE_RELATIONS entries must be literal`,
          );
        }
        if (relations.has(table)) {
          return panic(`${tableRelationsPath} repeats table ${table}`);
        }
        relations.set(table, relation);
      }
      return relations;
    }
  }
  return panic(`${tableRelationsPath} must export TABLE_RELATIONS`);
};

/**
 * SQL relation name to table export for every classified table. A classified
 * table without a relation name is fatal: counting its writes as zero would
 * hide them.
 */
export const classifiedTableRelations = (
  relations: ReadonlyMap<string, string>,
  tableExports: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const byRelation = new Map<string, string>();
  for (const table of tableExports) {
    const relation =
      relations.get(table) ??
      panic(`Classified table ${table} has no entry in ${tableRelationsPath}`);
    if (byRelation.has(relation)) {
      return panic(`Duplicate SQL relation name ${relation}`);
    }
    byRelation.set(relation, table);
  }
  return byRelation;
};

/** The HEAD-classified inputs a base measurement reuses. */
export type OrgWriteGraphHeadMetadata = {
  readonly registry: string;
  readonly tableRelations: string;
};

/** The measured HEAD tree's classification inputs. */
export const orgWriteGraphHeadMetadata = (
  read: (file: string) => string,
): OrgWriteGraphHeadMetadata => ({
  registry: read(scopeRegistryPath),
  tableRelations: read(tableRelationsPath),
});

export const deriveOrgWriteGraphInputs = (
  sources: ReadonlyMap<string, string>,
  ownershipSources: ReadonlyMap<string, string>,
  {
    role,
    head,
  }: {
    readonly role: OrgWriteGraphMeasurementRole;
    readonly head?: OrgWriteGraphHeadMetadata;
  },
): {
  readonly rootDoorFiles: ReadonlySet<string>;
  readonly recoveryOwnerFiles: ReadonlySet<string>;
  readonly orgTables: ReadonlySet<string>;
  readonly globalTables: ReadonlySet<string>;
  readonly sqlTables: ReadonlyMap<string, string>;
  readonly schedulerWriteIntents?: SchedulerWriteGraphContract;
} => {
  const recoveryContent = ownershipSources.get(recoveryOwnerPath);
  let recoveryOwnerFiles: ReadonlySet<string>;
  if (recoveryContent === undefined) {
    const recoveryModulePrefix = "apps/api/src/lib/db/recovery-bookkeeping/";
    if (
      [...sources.keys()].some((file) => file.startsWith(recoveryModulePrefix))
    ) {
      return panic(
        `Missing ${recoveryOwnerPath} while recovery modules exist in the measured tree`,
      );
    }
    if (role === "head") {
      return panic(`Missing tree source ${recoveryOwnerPath}`);
    }
    recoveryOwnerFiles = new Set();
  } else {
    recoveryOwnerFiles = parseRecoveryOwnerFiles(recoveryContent);
  }
  const metadata =
    head ??
    (role === "head"
      ? orgWriteGraphHeadMetadata(
          (file) => sources.get(file) ?? panic(`Missing tree source ${file}`),
        )
      : panic(
          "Base organization graph requires the measured HEAD scope registry and table relations",
        ));
  const { registry } = metadata;
  const orgTables = new Set(
    scopeTableExportNames(registry, scopeRegistryPath, "ORG_SCOPE_TABLES"),
  );
  const globalTables = new Set(
    scopeTableExportNames(registry, scopeRegistryPath, "GLOBAL_SCOPE_TABLES"),
  );
  const allTables = new Set([...orgTables, ...globalTables]);
  const schedulerWriteIntents = schedulerWriteGraphContract({
    registry,
    sources,
    orgTables,
    globalTables,
    role,
  });
  return {
    rootDoorFiles: parseRootConnectionDoorFiles(ownershipSources),
    recoveryOwnerFiles,
    orgTables,
    globalTables,
    sqlTables: classifiedTableRelations(
      parseTableRelations(metadata.tableRelations),
      allTables,
    ),
    ...(schedulerWriteIntents === undefined ? {} : { schedulerWriteIntents }),
  };
};

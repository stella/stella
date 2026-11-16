import { panic } from "better-result";
import path from "node:path";

import {
  type CallExpression,
  type Class,
  type ExportAllDeclaration,
  type ExportNamedDeclaration,
  type ImportDeclaration,
  type MemberExpression,
  type ModuleExportName,
  type Node,
  type ObjectProperty,
  parseSource,
  type Program,
  type TemplateLiteral,
  walk,
} from "@stll/scripts/src/syntax-tree";

import { factoriesWhere } from "@/api/lib/safe-handler-factories";

type CensusOptions = {
  sources: ReadonlyMap<string, string>;
  roots: readonly string[];
  routeFiles: readonly string[];
  declarations: ReadonlySet<string>;
};

// Handlers whose caller the framework did not authenticate.
const factories = new Set<string>(
  factoriesWhere(({ context }) => context !== "authenticated"),
);
const routeMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "options",
]);

type SourceFile = {
  fileName: string;
  program: Program;
  imports: readonly ImportDeclaration[];
  /** Every call in source order: the roots' handler seeds. */
  calls: readonly CallExpression[];
  sourceText: string;
};

type ExportDeclaration = ExportNamedDeclaration | ExportAllDeclaration;

const stringValue = (node: Node | null | undefined) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

const exportName = (name: ModuleExportName) =>
  name.type === "Literal" ? name.value : name.name;

/** A `receiver.name` access (not `receiver[name]`). */
const isNamedAccess = (
  node: Node | null | undefined,
): node is MemberExpression =>
  node?.type === "MemberExpression" && !node.computed;

/** The accessed name, with `#` for private names as the source spells it. */
const accessName = (node: MemberExpression) => {
  if (node.property.type === "PrivateIdentifier") {
    return `#${node.property.name}`;
  }
  return node.property.type === "Identifier" ? node.property.name : "";
};

/** An object literal entry written `name: value`. */
const isValueProperty = (node: Node): node is ObjectProperty =>
  node.type === "Property" &&
  node.kind === "init" &&
  !node.method &&
  !node.shorthand;

const isClassDeclaration = (node: Node | undefined): node is Class =>
  node?.type === "ClassDeclaration";

// Types never write rows; heritage clauses are read through `resolveReference`.
const TYPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeParameterInstantiation",
  "TSClassImplements",
  "TSInterfaceHeritage",
  "TSTypeReference",
  "TSTypeLiteral",
  "TSTypeQuery",
  "TSTypeOperator",
  "TSTypePredicate",
  "TSNamedTupleMember",
]);
const isTypeNode = (node: Node) =>
  node.type.startsWith("TS") &&
  (node.type.endsWith("Type") ||
    node.type.endsWith("Keyword") ||
    TYPE_NODES.has(node.type));

export const collectRetentionWrites = ({
  sources,
  roots,
  routeFiles,
  declarations,
}: CensusOptions) => {
  const files = new Map<string, SourceFile>();
  const fileOf = new Map<Node, SourceFile>();
  const parentOf = new Map<Node, Node>();
  const getFile = (name: string) => {
    const existing = files.get(name);
    if (existing) {
      return existing;
    }
    const source = sources.get(name);
    if (source === undefined) {
      return undefined;
    }
    const { program } = parseSource(name, source);
    const file = {
      fileName: name,
      program,
      imports: program.body.filter(
        (statement): statement is ImportDeclaration =>
          statement.type === "ImportDeclaration",
      ),
      calls: new Array<CallExpression>(),
      sourceText: source,
    };
    walk(program, (node, ancestors) => {
      fileOf.set(node, file);
      if (node.type === "CallExpression") {
        file.calls.push(node);
      }
      const parent = ancestors.at(-1);
      if (parent) {
        parentOf.set(node, parent);
      }
    });
    files.set(name, file);
    return file;
  };
  const sourceFileOf = (node: Node) => {
    const file = fileOf.get(node);
    if (!file) {
      return panic(
        "registration-retention-census: a node outside the parsed sources reached the resolver; parse its file through getFile first",
      );
    }
    return file;
  };
  const textOf = (node: Node) =>
    sourceFileOf(node).sourceText.slice(node.start, node.end);
  /** An entry's written name; a computed name never matches a plain one. */
  const keyText = (entry: Node) => {
    if (
      (entry.type === "Property" ||
        entry.type === "MethodDefinition" ||
        entry.type === "TSAbstractMethodDefinition" ||
        entry.type === "PropertyDefinition" ||
        entry.type === "TSAbstractPropertyDefinition" ||
        entry.type === "AccessorProperty" ||
        entry.type === "TSAbstractAccessorProperty") &&
      !entry.computed &&
      !(
        (entry.type === "MethodDefinition" ||
          entry.type === "TSAbstractMethodDefinition") &&
        entry.kind === "constructor"
      )
    ) {
      return textOf(entry.key);
    }
    return undefined;
  };
  const issues = new Set<string>();
  const tables = new Set<string>();
  const visited = new Set<Node>();
  const routeRoots = new Set(routeFiles);
  const externalBindings = new Set<string>();
  const resolveModule = (file: string, specifier: string) => {
    let base: string | undefined;
    if (specifier.startsWith("@/api/")) {
      base = `src/${specifier.slice("@/api/".length)}`;
    } else if (specifier.startsWith(".")) {
      base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );
    }
    if (!base) {
      return undefined;
    }
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (candidate) => sources.has(candidate),
    );
  };
  type ResolveOptions = {
    file: SourceFile;
    name: string;
    seen?: Set<string>;
  };
  type ResolveImportOptions = {
    statement: ImportDeclaration;
    file: SourceFile;
    name: string;
    seen: Set<string>;
  };
  const resolveImport = ({
    statement,
    file,
    name,
    seen,
  }: ResolveImportOptions): Node | undefined => {
    const key = `${file.fileName}:${name}`;
    if (statement.specifiers.length === 0 || statement.importKind === "type") {
      return undefined;
    }
    if (
      statement.attributes.some(
        (attribute) =>
          exportName(attribute.key) === "type" &&
          ["file", "json"].includes(attribute.value.value),
      )
    ) {
      return undefined;
    }
    let imported: string | undefined;
    for (const specifier of statement.specifiers) {
      if (specifier.local.name !== name) {
        continue;
      }
      if (specifier.type === "ImportDefaultSpecifier") {
        imported = "default";
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        imported = "*";
      } else if (specifier.importKind !== "type") {
        imported = exportName(specifier.imported);
      }
    }
    if (!imported) {
      return undefined;
    }
    const moduleName = statement.source.value;
    const target = resolveModule(file.fileName, moduleName);
    const targetFile = target === undefined ? undefined : getFile(target);
    if (targetFile !== undefined && imported === "*") {
      return undefined;
    }
    if (targetFile !== undefined) {
      const targetNode = resolve({
        file: targetFile,
        name: imported,
        seen,
      });
      if (
        !targetNode &&
        externalBindings.has(`${targetFile.fileName}:${imported}`)
      ) {
        externalBindings.add(key);
      } else if (!targetNode) {
        issues.add(`${key}: unresolved imported binding`);
      }
      return targetNode;
    }
    if (moduleName.startsWith("@/api/") || moduleName.startsWith(".")) {
      issues.add(`${key}: unresolved import`);
    } else {
      externalBindings.add(key);
    }
    return undefined;
  };
  type ResolveExportOptions = {
    statement: ExportDeclaration;
    file: SourceFile;
    name: string;
    seen: Set<string>;
  };
  const resolveExport = ({
    statement,
    file,
    name,
    seen,
  }: ResolveExportOptions): Node | undefined => {
    const key = `${file.fileName}:${name}`;
    const moduleName = statement.source?.value;
    const target =
      moduleName === undefined
        ? file.fileName
        : resolveModule(file.fileName, moduleName);
    const targetFile = target === undefined ? undefined : getFile(target);
    if (!targetFile) {
      const exportsName =
        statement.type === "ExportAllDeclaration"
          ? !statement.exported || exportName(statement.exported) === name
          : statement.specifiers.some(
              (element) => exportName(element.exported) === name,
            );
      if (
        moduleName !== undefined &&
        !moduleName.startsWith(".") &&
        !moduleName.startsWith("@/api/") &&
        exportsName
      ) {
        externalBindings.add(key);
      }
      return undefined;
    }
    if (statement.type === "ExportAllDeclaration") {
      if (statement.exported) {
        return undefined;
      }
      const found = resolve({
        file: targetFile,
        name,
        seen: new Set(seen),
      });
      if (found) {
        return found;
      }
      if (externalBindings.has(`${targetFile.fileName}:${name}`)) {
        externalBindings.add(key);
      }
      return undefined;
    }
    const binding = statement.specifiers.find(
      (element) => exportName(element.exported) === name,
    );
    if (binding) {
      const imported = exportName(binding.local);
      const found = resolve({ file: targetFile, name: imported, seen });
      if (
        !found &&
        externalBindings.has(`${targetFile.fileName}:${imported}`)
      ) {
        externalBindings.add(key);
      }
      return found;
    }
    return undefined;
  };
  const resolveDeclaration = (
    declaration: Node,
    name: string,
    isDefault: boolean,
  ): Node | undefined => {
    if (
      (declaration.type === "FunctionDeclaration" ||
        declaration.type === "TSDeclareFunction" ||
        declaration.type === "ClassDeclaration") &&
      (declaration.id?.name === name || (name === "default" && isDefault))
    ) {
      return declaration;
    }
    if (declaration.type !== "VariableDeclaration") {
      return undefined;
    }
    for (const declarator of declaration.declarations) {
      const binding = declarator.id;
      if (binding.type === "Identifier" && binding.name === name) {
        return declarator.init ?? undefined;
      }
      let elements: readonly (Node | null)[] = [];
      if (binding.type === "ObjectPattern") {
        elements = binding.properties.map((property) =>
          property.type === "RestElement" ? property : property.value,
        );
      } else if (binding.type === "ArrayPattern") {
        elements = binding.elements;
      }
      if (
        elements.some((element) => {
          let target = element;
          if (target?.type === "AssignmentPattern") {
            target = target.left;
          } else if (target?.type === "RestElement") {
            target = target.argument;
          }
          return target?.type === "Identifier" && target.name === name;
        })
      ) {
        return declarator.init ?? undefined;
      }
    }
    return undefined;
  };
  const resolve = ({
    file,
    name,
    seen = new Set<string>(),
  }: ResolveOptions): Node | undefined => {
    const key = `${file.fileName}:${name}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    for (const statement of file.program.body) {
      if (
        statement.type === "ExportNamedDeclaration" &&
        statement.declaration
      ) {
        const found = resolveDeclaration(statement.declaration, name, false);
        if (found) {
          return found;
        }
        continue;
      }
      if (
        statement.type === "ExportDefaultDeclaration" ||
        statement.type === "TSExportAssignment"
      ) {
        const declaration =
          statement.type === "ExportDefaultDeclaration"
            ? statement.declaration
            : statement.expression;
        if (
          declaration.type === "FunctionDeclaration" ||
          declaration.type === "TSDeclareFunction" ||
          declaration.type === "ClassDeclaration"
        ) {
          const found = resolveDeclaration(declaration, name, true);
          if (found) {
            return found;
          }
          continue;
        }
        if (
          declaration.type === "TSInterfaceDeclaration" ||
          name !== "default"
        ) {
          continue;
        }
        return declaration.type === "Identifier"
          ? resolve({ file, name: declaration.name, seen })
          : declaration;
      }
      const found = resolveDeclaration(statement, name, false);
      if (found) {
        return found;
      }
      if (statement.type === "ImportDeclaration") {
        const target = resolveImport({ statement, file, name, seen });
        if (target) {
          return target;
        }
      }
      if (
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration"
      ) {
        const target = resolveExport({ statement, file, name, seen });
        if (target) {
          return target;
        }
      }
    }
    return undefined;
  };
  const classMember = (receiver: Class, name: string) =>
    receiver.body.body.find((entry) => keyText(entry) === name);
  const resolveReference = (
    reference: Node,
    seen = new Set<Node>(),
  ): Node | undefined => {
    const node =
      reference.type === "ChainExpression" ? reference.expression : reference;
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (node.type === "ThisExpression") {
      for (
        let ancestor = parentOf.get(node);
        ancestor !== undefined;
        ancestor = parentOf.get(ancestor)
      ) {
        if (isClassDeclaration(ancestor)) {
          return ancestor;
        }
      }
      return undefined;
    }
    if (node.type === "Identifier") {
      const target = resolve({ file: sourceFileOf(node), name: node.name });
      if (target?.type === "Identifier") {
        return resolveReference(target, seen);
      }
      return target;
    }
    if (isNamedAccess(node)) {
      const name = accessName(node);
      const file = sourceFileOf(node);
      if (node.object.type === "Identifier") {
        for (const statement of file.imports) {
          const namespace = statement.specifiers.find(
            (specifier) => specifier.type === "ImportNamespaceSpecifier",
          );
          if (!namespace || namespace.local.name !== node.object.name) {
            continue;
          }
          const module = resolveModule(file.fileName, statement.source.value);
          const target = module === undefined ? undefined : getFile(module);
          if (target !== undefined) {
            const targetNode = resolve({ file: target, name });
            if (!targetNode) {
              issues.add(
                `${file.fileName}:${textOf(node)}: unresolved namespace binding`,
              );
            }
            return targetNode;
          }
          if (
            statement.source.value.startsWith(".") ||
            statement.source.value.startsWith("@/api/")
          ) {
            issues.add(`${file.fileName}: unresolved namespace import`);
          }
        }
      }
      const receiver = resolveReference(node.object, seen);
      if (receiver?.type === "ObjectExpression") {
        const property = receiver.properties.find(
          (entry) =>
            entry.type === "Property" &&
            keyText(entry)?.replaceAll('"', "").replaceAll("'", "") === name,
        );
        if (property?.type === "Property" && property.kind === "init") {
          if (property.method) {
            return property;
          }
          if (!property.shorthand) {
            return property.value;
          }
          if (property.key.type === "Identifier") {
            return resolve({
              file: sourceFileOf(property),
              name: property.key.name,
            });
          }
        }
      }
      if (isClassDeclaration(receiver)) {
        const member = classMember(receiver, name);
        if (member) {
          return member;
        }
        const bases = [
          receiver.superClass,
          ...(receiver.implements ?? []).map((clause) => clause.expression),
        ];
        for (const type of bases) {
          // A class without `extends` has no superclass to search.
          if (type === null) {
            continue;
          }
          const base = resolveReference(type, seen);
          if (isClassDeclaration(base)) {
            const inherited = classMember(base, name);
            if (inherited) {
              return inherited;
            }
          }
        }
      }
    }
    return undefined;
  };
  const tableName = (
    node: Node,
    seen = new Set<Node>(),
  ): string | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (
      node.type === "Identifier" ||
      isNamedAccess(node) ||
      (node.type === "ChainExpression" && isNamedAccess(node.expression))
    ) {
      const target = resolveReference(node);
      return target && tableName(target, seen);
    }
    if (
      node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression"
    ) {
      return tableName(node.expression, seen);
    }
    if (node.type === "CallExpression") {
      const callee = textOf(node.callee);
      const first = stringValue(node.arguments.at(0));
      if (
        /(?:^|\.)pgTable(?:\.withRLS)?$/u.test(callee) &&
        first !== undefined
      ) {
        return first;
      }
    }
    return undefined;
  };
  type RecordTableOptions = {
    node: Node;
    table: string | undefined;
    target: string;
  };
  const recordTable = ({ node, table, target }: RecordTableOptions) => {
    if (!table) {
      issues.add(
        `${sourceFileOf(node).fileName}: unresolved insert target ${target}`,
      );
      return;
    }
    tables.add(table);
    if (!declarations.has(table)) {
      issues.add(
        `${sourceFileOf(node).fileName}: missing retention declaration for ${table}`,
      );
    }
  };
  const sessionSetting = (property: Node) =>
    isValueProperty(property) &&
    ["validateAuth", "validateSession"].includes(keyText(property) ?? "");
  const isTrue = (node: Node) => node.type === "Literal" && node.value === true;
  const hasSessionGuard = (node: Node): boolean => {
    if (node.type === "ObjectExpression") {
      return node.properties.some(
        (property) =>
          sessionSetting(property) &&
          property.type === "Property" &&
          isTrue(property.value),
      );
    }
    if (node.type === "CallExpression" && isNamedAccess(node.callee)) {
      if (accessName(node.callee) === "guard") {
        const configuration = node.arguments.at(0);
        if (configuration?.type === "ObjectExpression") {
          const setting = configuration.properties.find(sessionSetting);
          if (setting?.type === "Property") {
            return isTrue(setting.value);
          }
        }
      }
      return hasSessionGuard(node.callee.object);
    }
    if (node.type === "Identifier") {
      const target = resolve({ file: sourceFileOf(node), name: node.name });
      return !!target && hasSessionGuard(target);
    }
    return false;
  };
  const factoryName = (
    node: Node,
    seen = new Set<Node>(),
  ): string | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    if (isNamedAccess(node)) {
      return accessName(node);
    }
    if (node.type !== "Identifier") {
      return undefined;
    }
    for (const statement of sourceFileOf(node).imports) {
      for (const binding of statement.specifiers) {
        if (
          binding.type === "ImportSpecifier" &&
          binding.local.name === node.name
        ) {
          return exportName(binding.imported);
        }
      }
    }
    const alias = resolve({ file: sourceFileOf(node), name: node.name });
    if (alias && (alias.type === "Identifier" || isNamedAccess(alias))) {
      return factoryName(alias, seen);
    }
    return node.name;
  };
  const templateSql = (node: TemplateLiteral) => {
    const text = (index: number) => {
      const quasi = node.quasis.at(index);
      return quasi?.value.cooked ?? quasi?.value.raw ?? "";
    };
    let sql = text(0);
    for (const index of node.expressions.keys()) {
      sql += `__slot_${index}__${text(index + 1)}`;
    }
    return { sql, expressions: [...node.expressions] };
  };
  const readSql = (
    node: Node,
    seen = new Set<Node>(),
  ): { sql: string; expressions: Node[] } | undefined => {
    if (seen.has(node)) {
      return undefined;
    }
    seen.add(node);
    const text = stringValue(node);
    if (text !== undefined) {
      return { sql: text, expressions: [] };
    }
    if (node.type === "TemplateLiteral") {
      return templateSql(node);
    }
    if (node.type === "Identifier" || isNamedAccess(node)) {
      const target = resolveReference(node);
      if (
        target &&
        (target.type === "Identifier" ||
          isNamedAccess(target) ||
          stringValue(target) !== undefined ||
          target.type === "TemplateLiteral")
      ) {
        return readSql(target, seen);
      }
    }
    return undefined;
  };
  type RecordSqlOptions = {
    node: Node;
    sql: string;
    expressions: Node[];
  };
  const recordSql = ({ node, sql, expressions }: RecordSqlOptions) => {
    for (const match of sql.matchAll(
      /\bINSERT\s+INTO\s+((?:"?[\w]+"?\.)?"?[\w]+"?)/giu,
    )) {
      const raw = match.at(1) ?? "";
      const slot = /^__slot_(\d+)__$/u.exec(raw);
      const expression = slot && expressions.at(Number(slot.at(1)));
      let table: string | undefined;
      if (expression) {
        table = tableName(expression);
      } else if (!slot) {
        table = raw.split(".").at(-1)?.replaceAll('"', "");
      }
      recordTable({
        node,
        table,
        target: expression ? textOf(expression) : raw,
      });
    }
  };
  const isRawSql = (node: Node) =>
    node.type === "CallExpression" &&
    isNamedAccess(node.callee) &&
    accessName(node.callee) === "raw" &&
    factoryName(node.callee.object) === "sql";
  const checkNamespaceAccess = (node: MemberExpression) => {
    if (node.object.type !== "Identifier") {
      return;
    }
    const file = sourceFileOf(node);
    for (const statement of file.imports) {
      const namespace = statement.specifiers.find(
        (specifier) => specifier.type === "ImportNamespaceSpecifier",
      );
      if (
        namespace &&
        namespace.local.name === node.object.name &&
        resolveModule(file.fileName, statement.source.value)
      ) {
        issues.add(
          `${file.fileName}: unresolved namespace access ${textOf(node)}`,
        );
      }
    }
  };
  /** Whether an identifier only declares or names a member, never reads a value. */
  const isDeclaredName = (node: Node, parent: Node | undefined) => {
    if (parent?.type === "MemberExpression") {
      return !parent.computed && parent.property === node;
    }
    if (parent?.type === "Property") {
      return (
        parent.key === node &&
        !parent.computed &&
        parentOf.get(parent)?.type === "ObjectExpression" &&
        parent.kind === "init" &&
        (parent.method || !parent.shorthand)
      );
    }
    if (
      parent?.type === "MethodDefinition" ||
      parent?.type === "TSAbstractMethodDefinition"
    ) {
      return (
        parent.key === node &&
        !parent.computed &&
        (parent.kind === "method" || parent.kind === "constructor")
      );
    }
    if (parent?.type === "CatchClause") {
      return parent.param === node;
    }
    if (
      parent?.type === "VariableDeclarator" ||
      parent?.type === "FunctionDeclaration" ||
      parent?.type === "TSDeclareFunction" ||
      parent?.type === "ClassDeclaration"
    ) {
      return parent.id === node;
    }
    if (parent?.type === "TSParameterProperty") {
      return true;
    }
    if (
      parent?.type === "AssignmentPattern" ||
      parent?.type === "RestElement"
    ) {
      const owner = parentOf.get(parent);
      return (
        (parent.type === "AssignmentPattern"
          ? parent.left === node
          : parent.argument === node) &&
        (owner?.type === "TSParameterProperty" || isParameterOf(parent, owner))
      );
    }
    return isParameterOf(node, parent);
  };
  const isParameterOf = (node: Node, owner: Node | undefined) =>
    (owner?.type === "FunctionDeclaration" ||
      owner?.type === "FunctionExpression" ||
      owner?.type === "TSDeclareFunction" ||
      owner?.type === "TSEmptyBodyFunctionExpression" ||
      owner?.type === "ArrowFunctionExpression") &&
    owner.params.some((parameter) => parameter === node);
  const visit = (node: Node) => {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    const parent = parentOf.get(node);
    if (
      isTypeNode(node) ||
      ((parent?.type === "ClassDeclaration" ||
        parent?.type === "ClassExpression") &&
        parent.superClass === node)
    ) {
      return;
    }
    if (node.type === "MemberExpression" && node.computed) {
      checkNamespaceAccess(node);
    }
    if (
      node.type === "CallExpression" &&
      isNamedAccess(node.callee) &&
      accessName(node.callee) === "insert"
    ) {
      const target = node.arguments.at(0);
      const table = target && tableName(target);
      const implementation = resolveReference(node.callee);
      if (!implementation) {
        recordTable({
          node,
          table,
          target: target ? textOf(target) : "<missing>",
        });
      }
    }
    if (
      node.type === "TaggedTemplateExpression" &&
      factoryName(node.tag) === "sql"
    ) {
      recordSql({ node, ...templateSql(node.quasi) });
    }
    if (node.type === "CallExpression" && isRawSql(node)) {
      const argument = node.arguments.at(0);
      const content = argument && readSql(argument);
      if (content) {
        recordSql({ node, ...content });
      }
    }
    if (
      node.type === "CallExpression" &&
      isNamedAccess(node.callee) &&
      accessName(node.callee) === "execute"
    ) {
      const argument = node.arguments.at(0);
      const command = argument && (resolveReference(argument) ?? argument);
      if (command?.type === "CallExpression" && isRawSql(command)) {
        const raw = command.arguments.at(0);
        if (!raw || !readSql(raw)) {
          issues.add(`${sourceFileOf(node).fileName}: unresolved SQL command`);
        }
      }
    }
    if (
      node.type === "CallExpression" ||
      node.type === "NewExpression" ||
      isNamedAccess(node)
    ) {
      const target = resolveReference(
        node.type === "MemberExpression" ? node : node.callee,
      );
      if (target) {
        visit(target);
      }
    }
    if (
      (node.type === "Identifier" || node.type === "JSXIdentifier") &&
      !isDeclaredName(node, parent)
    ) {
      const target = resolve({ file: sourceFileOf(node), name: node.name });
      if (target) {
        visit(target);
      }
    }
    walk(node, (child) => {
      if (child === node) {
        return undefined;
      }
      visit(child);
      return "skip-children";
    });
  };
  for (const name of routeRoots) {
    const file = getFile(name);
    if (!file) {
      continue;
    }
    for (const statement of file.program.body) {
      if (
        (statement.type !== "ExportNamedDeclaration" &&
          statement.type !== "ExportAllDeclaration") ||
        !statement.source
      ) {
        continue;
      }
      const target = resolveModule(name, statement.source.value);
      if (target) {
        routeRoots.add(target);
      } else {
        issues.add(`${name}: unresolved route export`);
      }
    }
  }
  for (const name of new Set([...roots, ...routeRoots])) {
    const file = getFile(name);
    if (!file) {
      issues.add(`${name}: unresolved root`);
      continue;
    }
    for (const node of file.calls) {
      if (factories.has(factoryName(node.callee) ?? "")) {
        visit(node);
      }
      if (
        routeRoots.has(name) &&
        isNamedAccess(node.callee) &&
        routeMethods.has(accessName(node.callee))
      ) {
        const handler = node.arguments.at(1);
        const options = node.arguments.at(2);
        const overridesSession =
          options?.type === "ObjectExpression" &&
          options.properties.some(sessionSetting);
        const requiresSession = hasSessionGuard(
          overridesSession ? options : node.callee.object,
        );
        if (handler && !requiresSession) {
          visit(handler);
        }
      }
    }
  }
  return { tables: [...tables].toSorted(), issues: [...issues].toSorted() };
};

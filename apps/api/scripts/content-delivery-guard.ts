import { panic } from "better-result";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import {
  discoverSafeHandlers,
  HANDLERS_GLOB,
  REPO_ROOT,
  type SafeHandlerDiscovery,
} from "./lib/enumerate-safe-handlers";
import {
  findHiddenEndpointMismatches,
  findStaleAllowlistEntries,
  INLINE_ENDPOINT_ALLOWLIST,
} from "./mcp-coverage-guard";

const FACTORY =
  /^createSafe(?:Root|Session|Token|Public|PublicSubject|PublicSubjectFollowUp)?Handler$/u;
const TERMINAL =
  /^(?:secureDocumentResponse|auditedPresignDownload|presignDownloadUrl|readTenantS3ArrayBuffer|getS3ObjectWithSignal|readS3Object\w*|readS3ArrayBuffer)$/u;
const isDeliveryOwner = (file: string) =>
  /(?:^|\/)lib\/(?:s3|s3-presign|secure-document-response|audited-download)(?:\.ts)?$/u.test(
    file,
  );
const propertyName = (node: ts.Node | undefined) =>
  node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
    ? node.text
    : undefined;
const scope = (node: ts.Node): ts.Node => {
  if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)) {
    return node;
  }
  return scope(node.parent);
};
const bindingScope = (node: ts.Node) =>
  scope(ts.isFunctionDeclaration(node) ? node.parent : node);
const encloses = (outer: ts.Node, inner: ts.Node) =>
  outer.getSourceFile() === inner.getSourceFile() &&
  outer.pos <= inner.pos &&
  outer.end >= inner.end;
const runtime = (node: ts.Node) =>
  !ts.isTypeNode(node) &&
  !ts.isInterfaceDeclaration(node) &&
  !ts.isTypeAliasDeclaration(node);

type AnalyzeContentDeliveryOptions = {
  files: readonly string[];
  readFile: (file: string) => string | undefined;
  resolveImport: (specifier: string, from: string) => string | undefined;
};

class ContentDeliveryInspector {
  private readonly options;
  constructor(options: AnalyzeContentDeliveryOptions) {
    this.options = options;
  }
  private readonly modules = new Map<string, ts.SourceFile>();
  private readonly bindings = new Map<ts.SourceFile, Map<string, ts.Node[]>>();
  private readonly errors = new Set<string>();
  private readonly load = (file: string) => {
    const cached = this.modules.get(file);
    if (cached) {
      return cached;
    }
    const source = this.options.readFile(file);
    if (source === undefined) {
      this.errors.add(`Cannot inspect ${file}`);
      return undefined;
    }
    const parsed = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    this.modules.set(file, parsed);
    const names = new Map<string, ts.Node[]>();
    this.bindings.set(parsed, names);
    const index = (node: ts.Node) => {
      if (!runtime(node)) {
        return;
      }
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isBindingElement(node) ||
          ts.isImportSpecifier(node) ||
          ts.isImportClause(node) ||
          ts.isNamespaceImport(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        const entries = names.get(node.name.text) ?? [];
        entries.push(node);
        names.set(node.name.text, entries);
      }
      ts.forEachChild(node, index);
    };
    index(parsed);
    return parsed;
  };
  private readonly lookup = (reference: ts.Identifier) => {
    const availableBindings =
      this.bindings.get(reference.getSourceFile())?.get(reference.text) ?? [];
    return availableBindings
      .filter((candidate) => encloses(bindingScope(candidate), reference))
      .toSorted(
        (a, b) =>
          bindingScope(a).end -
          bindingScope(a).pos -
          (bindingScope(b).end - bindingScope(b).pos),
      )
      .at(0);
  };
  private readonly importFile = (specifier: string, from: string) => {
    if (/\.(?:json|ttf|otf|woff2?|png|svg)$/u.test(specifier)) {
      return undefined;
    }
    const resolved = this.options.resolveImport(specifier, from);
    if (
      !resolved &&
      (specifier.startsWith(".") || specifier.startsWith("@/"))
    ) {
      this.errors.add(`Unresolved local import ${specifier} from ${from}`);
    }
    return resolved ? this.load(resolved) : undefined;
  };
  private readonly exportsSeen = new Set<string>();
  private readonly resolveReexport = (
    statement: ts.ExportDeclaration,
    file: ts.SourceFile,
    name: string,
  ): ts.Node | undefined => {
    const target =
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? this.importFile(statement.moduleSpecifier.text, file.fileName)
        : file;
    if (!target) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const entry = statement.exportClause.elements.find(
          (item) => item.name.text === name && !item.isTypeOnly,
        );
        if (entry) {
          return entry;
        }
      }
      return undefined;
    }
    if (!statement.exportClause) {
      const found = this.exported(target, name);
      if (found) {
        return found;
      }
    } else if (ts.isNamedExports(statement.exportClause)) {
      const entry = statement.exportClause.elements.find(
        (item) => item.name.text === name && !item.isTypeOnly,
      );
      if (!entry) {
        return undefined;
      }
      const original = entry.propertyName?.text ?? entry.name.text;
      return target === file
        ? this.bindings.get(file)?.get(original)?.at(0)
        : this.exported(target, original);
    }
    return undefined;
  };
  private readonly exported = (
    file: ts.SourceFile,
    name: string,
  ): ts.Node | undefined => {
    const key = `${file.fileName}#${name}`;
    if (this.exportsSeen.has(key)) {
      return undefined;
    }
    this.exportsSeen.add(key);
    for (const statement of file.statements) {
      if (name === "default" && ts.isExportAssignment(statement)) {
        return statement.expression;
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const found = this.resolveReexport(statement, file, name);
        if (found) {
          return found;
        }
        continue;
      }
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }
      const isDefault = ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        (isDefault ? name === "default" : statement.name?.text === name)
      ) {
        return statement;
      }
      if (ts.isVariableStatement(statement)) {
        const found = statement.declarationList.declarations.find(
          (item) => propertyName(item.name) === name,
        );
        if (found) {
          return found;
        }
        const binding = this.bindings
          .get(file)
          ?.get(name)
          ?.find(
            (item) =>
              ts.isBindingElement(item) &&
              statement.pos <= item.pos &&
              statement.end >= item.end,
          );
        if (binding) {
          return binding;
        }
      }
    }
    return undefined;
  };
  private readonly candidates: {
    file: string;
    line: number;
    binding: string;
    terminals: string[];
    declared: boolean;
  }[] = [];
  private readonly value = (
    node: ts.Node | undefined,
    resolvedNodes = new Set<ts.Node>(),
  ): ts.Node | undefined => {
    if (!node || resolvedNodes.has(node)) {
      return undefined;
    }
    resolvedNodes.add(node);
    if (ts.isIdentifier(node)) {
      return this.value(this.lookup(node), resolvedNodes);
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
      return this.value(node.initializer, resolvedNodes);
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      return this.value(node.expression, resolvedNodes);
    }
    return node;
  };
  private readonly field = (node: ts.Node | undefined, name: string) => {
    const object = this.value(node);
    if (!object || !ts.isObjectLiteralExpression(object)) {
      return undefined;
    }
    return this.value(
      object.properties.find(
        (item) =>
          ts.isPropertyAssignment(item) && propertyName(item.name) === name,
      ),
    );
  };

  private terminals = new Set<string>();
  private visited = new Set<ts.Node>();
  private readonly traceExport = (target: ts.SourceFile, name: string) => {
    if (TERMINAL.test(name) && isDeliveryOwner(target.fileName)) {
      this.terminals.add(name);
      return;
    }
    this.exportsSeen.clear();
    const definition = this.exported(target, name);
    if (!definition) {
      this.errors.add(`Unresolved local symbol ${target.fileName}#${name}`);
      return;
    }
    this.trace(definition, true);
  };
  private readonly traceImport = (definition: ts.Node, member?: string) => {
    let current = definition;
    while (!ts.isImportDeclaration(current) && !ts.isSourceFile(current)) {
      current = current.parent;
    }
    if (
      !ts.isImportDeclaration(current) ||
      !ts.isStringLiteralLike(current.moduleSpecifier)
    ) {
      return;
    }
    if (
      current.attributes?.elements.some(
        (attribute) =>
          propertyName(attribute.name) === "type" &&
          ts.isStringLiteralLike(attribute.value) &&
          attribute.value.text === "text",
      )
    ) {
      return;
    }
    const name =
      member ??
      (ts.isImportSpecifier(definition)
        ? (definition.propertyName?.text ?? definition.name.text)
        : "default");
    const resolved = this.options.resolveImport(
      current.moduleSpecifier.text,
      current.getSourceFile().fileName,
    );
    if (resolved && TERMINAL.test(name) && isDeliveryOwner(resolved)) {
      this.terminals.add(name);
      return;
    }
    const target = this.importFile(
      current.moduleSpecifier.text,
      current.getSourceFile().fileName,
    );
    if (target) {
      this.traceExport(target, name);
    }
  };
  private readonly shouldDefer = (current: ts.Node, referenced: boolean) => {
    if (
      !referenced &&
      (ts.isFunctionDeclaration(current) ||
        (ts.isVariableDeclaration(current) &&
          current.initializer &&
          (ts.isArrowFunction(current.initializer) ||
            ts.isFunctionExpression(current.initializer))))
    ) {
      return true;
    }
    return false;
  };
  private readonly traceNamespaceAccess = (current: ts.Node) => {
    if (ts.isNamespaceImport(current)) {
      const declaration = current.parent.parent;
      if (
        ts.isImportDeclaration(declaration) &&
        ts.isStringLiteralLike(declaration.moduleSpecifier)
      ) {
        const specifier = declaration.moduleSpecifier.text;
        if (
          this.options.resolveImport(
            specifier,
            declaration.getSourceFile().fileName,
          )
        ) {
          this.errors.add(
            `Unresolved namespace member ${current.name.text} in ${declaration.getSourceFile().fileName}`,
          );
        } else {
          this.importFile(specifier, declaration.getSourceFile().fileName);
        }
      }
      return true;
    }
    if (
      ts.isPropertyAccessExpression(current) &&
      ts.isIdentifier(current.expression)
    ) {
      const definition = this.lookup(current.expression);
      if (definition && ts.isNamespaceImport(definition)) {
        this.traceImport(definition, current.name.text);
        return true;
      }
    }
    if (
      ts.isElementAccessExpression(current) &&
      ts.isIdentifier(current.expression) &&
      ts.isStringLiteralLike(current.argumentExpression)
    ) {
      const definition = this.lookup(current.expression);
      if (definition && ts.isNamespaceImport(definition)) {
        this.traceImport(definition, current.argumentExpression.text);
        return true;
      }
    }
    return false;
  };
  private readonly detectOwner = (current: ts.Node) => {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isFunctionDeclaration(current)) &&
      isDeliveryOwner(current.getSourceFile().fileName)
    ) {
      const name = propertyName(current.name);
      if (name && TERMINAL.test(name)) {
        this.terminals.add(name);
        return true;
      }
    }
    return false;
  };
  private readonly trace = (current: ts.Node, referenced = false) => {
    if (this.visited.has(current) || !runtime(current)) {
      return;
    }
    if (this.shouldDefer(current, referenced)) {
      return;
    }
    this.visited.add(current);
    if (this.detectOwner(current)) {
      return;
    }
    this.detectDisposition(current);
    this.detectStoreSigner(current);
    if (
      ts.isCallExpression(current) &&
      current.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      this.traceDynamicImport(current);
      return;
    }
    if (ts.isImportSpecifier(current) || ts.isImportClause(current)) {
      this.traceImport(current);
      return;
    }
    if (ts.isParameter(current)) {
      if (current.initializer) {
        this.trace(current.initializer);
      }
      return;
    }
    if (this.traceNamespaceAccess(current)) {
      return;
    }
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
          parent.name === current)
      ) {
        return;
      }
      const definition = this.lookup(current);
      if (definition && definition !== parent) {
        this.trace(definition, true);
      }
      return;
    }
    if (ts.isVariableDeclaration(current)) {
      if (
        current.initializer &&
        (referenced ||
          (!ts.isArrowFunction(current.initializer) &&
            !ts.isFunctionExpression(current.initializer)))
      ) {
        this.trace(current.initializer);
      }
      return;
    }
    if (ts.isBindingElement(current)) {
      this.trace(current.parent.parent, true);
      return;
    }
    ts.forEachChild(current, (child) => this.trace(child));
  };

  /** Whether `identifier` names a binding a delivery owner module provides. */
  private readonly boundToOwner = (identifier: ts.Identifier): boolean => {
    const definition = this.lookup(identifier);
    if (!definition) {
      return false;
    }
    if (isDeliveryOwner(definition.getSourceFile().fileName)) {
      return true;
    }
    if (ts.isVariableDeclaration(definition)) {
      return (
        definition.initializer !== undefined &&
        this.isOwnerStore(definition.initializer)
      );
    }
    let current: ts.Node = definition;
    while (!ts.isImportDeclaration(current) && !ts.isSourceFile(current)) {
      current = current.parent;
    }
    if (
      !ts.isImportDeclaration(current) ||
      !ts.isStringLiteralLike(current.moduleSpecifier)
    ) {
      return false;
    }
    const resolved = this.options.resolveImport(
      current.moduleSpecifier.text,
      current.getSourceFile().fileName,
    );
    return resolved !== undefined && isDeliveryOwner(resolved);
  };
  /** An object store a delivery owner hands out: `getS3()`, `store.client()`, or a binding to one. */
  private readonly isOwnerStore = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      return this.boundToOwner(expression);
    }
    if (ts.isCallExpression(expression)) {
      return this.isOwnerStore(expression.expression);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return this.isOwnerStore(expression.expression);
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAwaitExpression(expression)
    ) {
      return this.isOwnerStore(expression.expression);
    }
    return false;
  };
  // Presigning on a store from the S3 owner (`getS3().presign(key)`) grants
  // the same stored bytes as `presignDownloadUrl`.
  private readonly detectStoreSigner = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "presign" &&
      this.isOwnerStore(current.expression.expression)
    ) {
      this.terminals.add("presign");
    }
  };

  private readonly detectDisposition = (current: ts.Node) => {
    const headerName = (key: ts.Node | undefined) =>
      propertyName(this.value(key))?.toLowerCase() === "content-disposition";
    if (
      ts.isPropertyAssignment(current) &&
      headerName(
        ts.isComputedPropertyName(current.name)
          ? current.name.expression
          : current.name,
      )
    ) {
      this.terminals.add("Content-Disposition");
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(current.left) &&
      headerName(current.left.argumentExpression)
    ) {
      this.terminals.add("Content-Disposition");
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["set", "append"].includes(current.expression.name.text) &&
      headerName(current.arguments.at(0))
    ) {
      this.terminals.add("Content-Disposition");
    }
    if (
      ts.isNewExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "Headers"
    ) {
      const inspectHeader = (child: ts.Node) => {
        if (ts.isStringLiteralLike(child) && headerName(child)) {
          this.terminals.add("Content-Disposition");
        }
        ts.forEachChild(child, inspectHeader);
      };
      ts.forEachChild(current, inspectHeader);
    }
  };
  private readonly traceDynamicImport = (current: ts.CallExpression) => {
    const specifier = current.arguments.at(0);
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      this.errors.add(
        `Unresolved dynamic import at ${current.getSourceFile().fileName}:${current.getSourceFile().getLineAndCharacterOfPosition(current.getStart()).line + 1}`,
      );
      return;
    }
    const target = this.importFile(
      specifier.text,
      current.getSourceFile().fileName,
    );
    if (!target) {
      return;
    }
    let use: ts.Node = current;
    while (
      ts.isAwaitExpression(use.parent) ||
      ts.isParenthesizedExpression(use.parent)
    ) {
      use = use.parent;
    }
    if (ts.isPropertyAccessExpression(use.parent)) {
      this.traceExport(target, use.parent.name.text);
      return;
    }
    if (ts.isVariableDeclaration(use.parent)) {
      const declaration = use.parent;
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          const name = propertyName(element.propertyName ?? element.name);
          if (!name || element.dotDotDotToken) {
            this.errors.add(
              `Unresolved dynamic namespace binding in ${target.fileName}`,
            );
          } else {
            this.traceExport(target, name);
          }
        }
        return;
      }
      const inspectUse = (reference: ts.Node) => {
        if (!runtime(reference)) {
          return;
        }
        if (
          ts.isIdentifier(reference) &&
          reference !== declaration.name &&
          this.lookup(reference) === declaration
        ) {
          const parent = reference.parent;
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === reference
          ) {
            this.traceExport(target, parent.name.text);
          } else if (
            ts.isElementAccessExpression(parent) &&
            parent.expression === reference &&
            ts.isStringLiteralLike(parent.argumentExpression)
          ) {
            this.traceExport(target, parent.argumentExpression.text);
          } else {
            this.errors.add(
              `Unresolved dynamic namespace use in ${target.fileName}`,
            );
          }
          return;
        }
        ts.forEachChild(reference, inspectUse);
      };
      inspectUse(declaration.getSourceFile());
      return;
    }
    // A reached module namespace can be injected or dispatched; all of its
    // runtime exports are possible callees, but its unused imports are not.
    for (const statement of target.statements) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          for (const entry of statement.exportClause.elements) {
            if (!entry.isTypeOnly) {
              this.traceExport(target, entry.name.text);
            }
          }
        } else {
          this.errors.add(
            `Unresolved dynamic namespace re-export in ${target.fileName}`,
          );
        }
      }
      if (ts.isExportAssignment(statement)) {
        this.trace(statement.expression, true);
      }
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          this.trace(declaration, true);
        }
      } else {
        this.trace(statement, true);
      }
    }
    return;
  };

  private readonly checkFactoryAliases = (node: ts.Node) => {
    const file = node.getSourceFile().fileName;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const definition = this.value(node.expression);
      if (
        definition &&
        ts.isImportSpecifier(definition) &&
        FACTORY.test(definition.propertyName?.text ?? definition.name.text) &&
        !FACTORY.test(node.expression.text)
      ) {
        this.errors.add(`Aliased safe factory cannot be enumerated in ${file}`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      FACTORY.test(node.expression.name.text)
    ) {
      this.errors.add(`Namespace safe factory cannot be enumerated in ${file}`);
    }
  };
  private readonly isDeclared = (
    first: ts.Node | undefined,
    subject: boolean,
  ) => {
    const config =
      subject && first && ts.isObjectLiteralExpression(first)
        ? first.properties.find(
            (item) =>
              ts.isPropertyAssignment(item) &&
              propertyName(item.name) === "config",
          )
        : first;
    const configValue =
      config && ts.isPropertyAssignment(config) ? config.initializer : config;
    const delivery = this.field(configValue, "contentDelivery");
    const type = propertyName(this.field(delivery, "type"));
    const reason = propertyName(this.field(delivery, "reason"));
    return (
      type === "audited" ||
      ((type === "public" || type === "none") && !!reason?.trim())
    );
  };
  private readonly inspectFactory = (node: ts.Node) => {
    const file = node.getSourceFile().fileName;

    if (!runtime(node)) {
      return;
    }
    this.checkFactoryAliases(node);
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !FACTORY.test(node.expression.text)
    ) {
      ts.forEachChild(node, this.inspectFactory);
      return;
    }
    const first = node.arguments.at(0);
    const subject = node.expression.text.includes("Subject");
    const declared = this.isDeclared(first, subject);
    this.terminals = new Set<string>();
    this.visited = new Set<ts.Node>();
    if (subject && first && ts.isObjectLiteralExpression(first)) {
      for (const item of first.properties) {
        if (
          ts.isPropertyAssignment(item) &&
          propertyName(item.name) !== "config"
        ) {
          this.trace(item.initializer);
        }
      }
    } else {
      const callback = node.arguments.at(1);
      if (!callback) {
        this.errors.add(`Missing callback in ${file}`);
      } else {
        this.trace(callback, true);
      }
    }
    let binding = "inline";
    if (ts.isVariableDeclaration(node.parent)) {
      binding = propertyName(node.parent.name) ?? "inline";
    } else if (ts.isExportAssignment(node.parent)) {
      binding = "default";
    }
    if (this.terminals.size > 0) {
      this.candidates.push({
        file,
        binding,
        line:
          node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
            .line + 1,
        terminals: [...this.terminals].toSorted(),
        declared,
      });
    }
    ts.forEachChild(node, this.inspectFactory);
  };

  analyze = () => {
    for (const file of this.options.files) {
      const source = this.load(file);
      if (source) {
        this.inspectFactory(source);
      }
    }
    return { candidates: this.candidates, errors: [...this.errors].toSorted() };
  };
}

/** Trace runtime references, not module imports: an unused reader is not delivery. */
export const analyzeContentDelivery = (
  options: AnalyzeContentDeliveryOptions,
) => new ContentDeliveryInspector(options).analyze();

export const discoveryFailures = ({
  files,
  importErrors,
}: SafeHandlerDiscovery) => [
  ...importErrors.map(({ id, message }) => `Import failed ${id}: ${message}`),
  ...findHiddenEndpointMismatches({
    files,
    allowlist: INLINE_ENDPOINT_ALLOWLIST,
  }).map(({ id }) => `Hidden endpoint in ${id}`),
  ...findStaleAllowlistEntries({
    files,
    allowlist: INLINE_ENDPOINT_ALLOWLIST,
  }).map((id) => `Stale inline endpoint allowance ${id}`),
];

export const selfTestContentDelivery = () => {
  const result = analyzeContentDelivery({
    files: ["/route.ts"],
    readFile: () =>
      'import { readS3ArrayBuffer as read } from "@/api/lib/s3"; export default createSafeHandler({}, () => read("key"));',
    resolveImport: () => "/apps/api/src/lib/s3.ts",
  });
  if (
    result.errors.length ||
    result.candidates.length !== 1 ||
    result.candidates.at(0)?.declared !== false
  ) {
    panic(
      "content-delivery self-test failed to detect an undeclared byte route",
    );
  }
};

if (import.meta.main && Bun.argv.includes("--self-test")) {
  selfTestContentDelivery();
  console.log("content-delivery-guard self-test passed");
} else if (import.meta.main) {
  const discovery = await discoverSafeHandlers();
  const result = analyzeContentDelivery({
    // AST-only scan shares the discovery glob without importing helper scripts;
    // it also catches aliased factories the runtime text prefilter cannot see.
    files: [
      ...new Bun.Glob(HANDLERS_GLOB).scanSync({
        cwd: REPO_ROOT,
        absolute: true,
      }),
    ]
      .filter((file) => !file.endsWith(".test.ts"))
      .toSorted(),
    readFile: (file) =>
      existsSync(file) ? readFileSync(file, "utf-8") : undefined,
    resolveImport: (specifier, from) => {
      let base: string | undefined;
      if (specifier.startsWith("@/api/")) {
        base = path.join(REPO_ROOT, "apps/api/src", specifier.slice(6));
      } else if (specifier.startsWith(".")) {
        base = path.resolve(path.dirname(from), specifier);
      }
      if (!base) {
        return undefined;
      }
      return [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, "index.ts"),
      ].find(
        (file) =>
          existsSync(file) &&
          statSync(file).isFile() &&
          /\.[cm]?[jt]sx?$/u.test(file),
      );
    },
  });
  const failures = [
    ...discoveryFailures(discovery),
    ...result.errors,
    ...result.candidates
      .filter(({ declared }) => !declared)
      .map(
        ({ file, line, binding }) =>
          `Missing contentDelivery: ${repoRelativePath(REPO_ROOT, file)}:${line} (${binding})`,
      ),
  ];
  for (const { file, line, binding, terminals } of result.candidates) {
    console.log(
      `${repoRelativePath(REPO_ROOT, file)}:${line} (${binding}): ${terminals.join(", ")}`,
    );
  }
  for (const failure of failures) {
    console.error(failure);
  }
  console.log(
    `content-delivery-guard: ${result.candidates.length} delivery callbacks, ${failures.length} failures`,
  );
  process.exit(failures.length > 0 ? 1 : 0);
}

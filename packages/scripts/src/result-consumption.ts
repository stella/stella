import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const BETTER_RESULT_PACKAGE = `${path.sep}node_modules${path.sep}better-result${path.sep}`;
const RESULT_VARIANT_STATUS = new Map([
  ["Err", "error"],
  ["Ok", "ok"],
]);
const PRODUCT_SOURCE_PATTERN =
  /^(?:(?:apps|packages)\/[^/]+\/src\/.*|apps\/[^/]+\/scripts\/.*|scripts\/.*)\.tsx?$/u;
const TEST_FILE_PATTERN =
  /(?:\.test\.|\.spec\.|\/tests\/|\/__tests__\/|\/e2e\/)/u;
const GENERATED_OR_EXTERNAL_PATTERN =
  /(?:\.d\.ts$|\.gen\.tsx?$|\/generated\/|\/node_modules\/|routeTree\.gen)/u;
const RESULT_IMPORT_PATTERN =
  /import\s+(?:type\s+)?\{[^}]*\bResult\b[^}]*\}\s*from\s*["']better-result["']/su;

export type ResultConsumptionDiagnostic = {
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly rule: "result-unwrap-requires-message" | "unused-result";
};

type ScanProgramOptions = {
  readonly program: ts.Program;
  readonly repositoryRoot: string;
  readonly sourceFiles?: ReadonlySet<string>;
};

export const scanResultConsumption = ({
  program,
  repositoryRoot,
  sourceFiles,
}: ScanProgramOptions): ResultConsumptionDiagnostic[] => {
  const checker = program.getTypeChecker();
  const diagnostics: ResultConsumptionDiagnostic[] = [];
  const reportedDiscardedExpressions = new Set<ts.Expression>();

  for (const sourceFile of program.getSourceFiles()) {
    if (
      !isProductSourceFile(sourceFile, repositoryRoot) ||
      (sourceFiles !== undefined && !sourceFiles.has(sourceFile.fileName))
    ) {
      continue;
    }

    const reportDiscardedResult = (expression: ts.Expression): void => {
      if (reportedDiscardedExpressions.has(expression)) {
        return;
      }
      reportedDiscardedExpressions.add(expression);
      diagnostics.push(
        createDiagnostic({
          node: expression,
          repositoryRoot,
          rule: "unused-result",
          message:
            "This better-result Result is discarded. Return, assign, yield, or explicitly consume it.",
        }),
      );
    };

    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        inspectDiscardedExpression({
          checker,
          expression: node.expression,
          report: reportDiscardedResult,
        });
      }

      if (isCommaExpression(node)) {
        // A comma expression always discards its non-final operand, even when
        // the surrounding expression is assigned, returned, or passed on.
        inspectDiscardedExpression({
          checker,
          expression: node.left,
          report: reportDiscardedResult,
        });
      }

      if (ts.isCallExpression(node) && isUnwrapWithoutMessage(node, checker)) {
        diagnostics.push(
          createDiagnostic({
            node,
            repositoryRoot,
            rule: "result-unwrap-requires-message",
            message:
              "Unwrapping a Result requires a non-empty literal invariant message.",
          }),
        );
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return diagnostics;
};

const isAssignmentExpression = (expression: ts.Expression): boolean =>
  ts.isBinaryExpression(expression) &&
  expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

const isProductSourcePath = (file: string): boolean =>
  PRODUCT_SOURCE_PATTERN.test(file) &&
  !TEST_FILE_PATTERN.test(file) &&
  !GENERATED_OR_EXTERNAL_PATTERN.test(file);

const isProductSourceFile = (
  sourceFile: ts.SourceFile,
  repositoryRoot: string,
): boolean => {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const relative = path.relative(repositoryRoot, sourceFile.fileName);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  return isProductSourcePath(relative.replaceAll(path.sep, "/"));
};

const isCommaExpression = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.CommaToken;

const unwrapDiscardedExpression = (
  expression: ts.Expression,
): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapDiscardedExpression(expression.expression);
  }

  if (ts.isVoidExpression(expression)) {
    return unwrapDiscardedExpression(expression.expression);
  }

  return expression;
};

type InspectDiscardedExpressionOptions = {
  readonly checker: ts.TypeChecker;
  readonly expression: ts.Expression;
  readonly report: (expression: ts.Expression) => void;
};

const inspectDiscardedExpression = ({
  checker,
  expression: candidate,
  report,
}: InspectDiscardedExpressionOptions): void => {
  const expression = unwrapDiscardedExpression(candidate);
  if (isAssignmentExpression(expression)) {
    return;
  }

  if (isCommaExpression(expression)) {
    inspectDiscardedExpression({
      checker,
      expression: expression.left,
      report,
    });
    inspectDiscardedExpression({
      checker,
      expression: expression.right,
      report,
    });
    return;
  }

  if (ts.isCommaListExpression(expression)) {
    for (const element of expression.elements) {
      inspectDiscardedExpression({
        checker,
        expression: element,
        report,
      });
    }
    return;
  }

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        inspectDiscardedExpression({
          checker,
          expression: property.initializer,
          report,
        });
      } else if (ts.isShorthandPropertyAssignment(property)) {
        inspectDiscardedExpression({
          checker,
          expression: property.name,
          report,
        });
      } else if (ts.isSpreadAssignment(property)) {
        inspectDiscardedExpression({
          checker,
          expression: property.expression,
          report,
        });
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (!ts.isOmittedExpression(element)) {
        inspectDiscardedExpression({
          checker,
          expression: ts.isSpreadElement(element)
            ? element.expression
            : element,
          report,
        });
      }
    }
    return;
  }

  if (ts.isTemplateExpression(expression)) {
    for (const { expression: interpolation } of expression.templateSpans) {
      inspectDiscardedExpression({
        checker,
        expression: interpolation,
        report,
      });
    }
    return;
  }

  if (isBetterResultValueType(checker, checker.getTypeAtLocation(expression))) {
    report(expression);
  }
};

const isBetterResultVariant = (
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean => {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const expectedStatus =
    symbol === undefined
      ? undefined
      : RESULT_VARIANT_STATUS.get(symbol.getName());
  if (symbol === undefined || expectedStatus === undefined) {
    return false;
  }

  if (symbol.declarations?.some(isBetterResultDeclaration) !== true) {
    return false;
  }

  const statusProperty = type.getProperty("status");
  const statusDeclaration =
    statusProperty?.valueDeclaration ?? statusProperty?.declarations?.at(0);
  if (statusProperty === undefined || statusDeclaration === undefined) {
    return false;
  }

  const statusType = checker.getTypeOfSymbolAtLocation(
    statusProperty,
    statusDeclaration,
  );
  return statusType.isStringLiteral() && statusType.value === expectedStatus;
};

const isBetterResultType = (
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean => {
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => isBetterResultType(checker, part));
  }

  // Require three independent signals before reporting: the public variant
  // name, a declaration owned by better-result, and its matching literal
  // status discriminant. Structural lookalikes and local Ok/Err classes can
  // satisfy at most two of those signals.
  return isBetterResultVariant(checker, type);
};

const promiseFulfilledValueType = (
  checker: ts.TypeChecker,
  type: ts.Type,
): ts.Type | undefined => {
  if (type.isUnionOrIntersection()) {
    for (const part of type.types) {
      const valueType = promiseFulfilledValueType(checker, part);
      if (valueType !== undefined) {
        return valueType;
      }
    }
    return undefined;
  }

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (
    symbol?.getName() !== "PromiseFulfilledResult" ||
    symbol.declarations?.some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll("\\", "/")
        .endsWith("/lib.es2020.promise.d.ts"),
    ) !== true
  ) {
    return undefined;
  }

  const value = type.getProperty("value");
  const declaration = value?.valueDeclaration ?? value?.declarations?.at(0);
  return value === undefined || declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(value, declaration);
};

const isBetterResultValueType = (
  checker: ts.TypeChecker,
  type: ts.Type,
  seen = new Set<ts.Type>(),
): boolean => {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  if (isBetterResultType(checker, type)) {
    return true;
  }

  const awaitedType = checker.getAwaitedType(type);
  if (
    awaitedType !== undefined &&
    awaitedType !== type &&
    isBetterResultValueType(checker, awaitedType, seen)
  ) {
    return true;
  }

  const fulfilledValueType = promiseFulfilledValueType(checker, type);
  if (
    fulfilledValueType !== undefined &&
    fulfilledValueType !== type &&
    isBetterResultValueType(checker, fulfilledValueType, seen)
  ) {
    return true;
  }

  const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return (
    elementType !== undefined &&
    elementType !== type &&
    isBetterResultValueType(checker, elementType, seen)
  );
};

const isBetterResultDeclaration = (declaration: ts.Declaration): boolean =>
  path
    .normalize(declaration.getSourceFile().fileName)
    .includes(BETTER_RESULT_PACKAGE);

const isUnwrapWithoutMessage = (
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean => {
  const signature = checker.getResolvedSignature(call);
  if (
    signature?.declaration === undefined ||
    !isBetterResultDeclaration(signature.declaration)
  ) {
    return false;
  }

  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "unwrap") {
    return false;
  }

  const messageArgumentIndex = signature.getParameters().length === 2 ? 1 : 0;
  const message = call.arguments.at(messageArgumentIndex);
  return (
    message === undefined ||
    !ts.isStringLiteralLike(message) ||
    message.text.trim().length === 0
  );
};

type CreateDiagnosticOptions = {
  readonly message: string;
  readonly node: ts.Node;
  readonly repositoryRoot: string;
  readonly rule: ResultConsumptionDiagnostic["rule"];
};

const createDiagnostic = ({
  message,
  node,
  repositoryRoot,
  rule,
}: CreateDiagnosticOptions): ResultConsumptionDiagnostic => {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return {
    column: position.character + 1,
    file: path.relative(repositoryRoot, sourceFile.fileName),
    line: position.line + 1,
    message,
    rule,
  };
};

type CreateProgramOptions = {
  readonly configPath: string;
  readonly rootNames?: readonly string[];
};

const createProgram = ({
  configPath,
  rootNames,
}: CreateProgramOptions): ts.Program => {
  const configFile = ts.readConfigFile(configPath, (file) =>
    ts.sys.readFile(file),
  );
  if (configFile.error !== undefined) {
    panic(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    panic(
      parsed.errors
        .map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, "\n"),
        )
        .join("\n"),
    );
  }

  const options = {
    rootNames:
      rootNames === undefined
        ? parsed.fileNames
        : [
            ...rootNames,
            ...parsed.fileNames.filter((file) => file.endsWith(".d.ts")),
          ],
    options: parsed.options,
  };
  if (parsed.projectReferences === undefined) {
    return ts.createProgram(options);
  }
  return ts.createProgram({
    ...options,
    projectReferences: parsed.projectReferences,
  });
};

type CliOptions =
  | { readonly mode: "all" }
  | { readonly base: string; readonly mode: "changed" };

const parseCliOptions = (): CliOptions => {
  if (process.argv.includes("--all")) {
    return { mode: "all" };
  }

  const baseIndex = process.argv.indexOf("--base");
  const explicitBase =
    baseIndex === -1 ? undefined : process.argv.at(baseIndex + 1);
  if (baseIndex !== -1 && explicitBase === undefined) {
    panic("--base requires a git ref");
  }
  return {
    base: explicitBase ?? process.env["TURBO_SCM_BASE"] ?? "origin/main",
    mode: "changed",
  };
};

const gitLines = (
  repositoryRoot: string,
  args: readonly string[],
): string[] => {
  const output = execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf-8",
  });
  return output.split("\n").filter(Boolean);
};

const changedSourceFiles = (repositoryRoot: string, base: string): string[] => {
  const files = new Set([
    ...gitLines(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      `${base}...HEAD`,
    ]),
    ...gitLines(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "HEAD",
    ]),
    ...gitLines(repositoryRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  return [...files]
    .filter(isProductSourcePath)
    .map((file) => path.join(repositoryRoot, file))
    .sort();
};

const workspaceConfig = (
  repositoryRoot: string,
  sourceFile: string,
): string | null => {
  const [parent, workspace, directory] = path
    .relative(repositoryRoot, sourceFile)
    .split(path.sep);
  if (parent === "scripts") {
    const config = path.join(repositoryRoot, "scripts", "tsconfig.json");
    return ts.sys.fileExists(config) ? config : null;
  }
  if ((parent !== "apps" && parent !== "packages") || workspace === undefined) {
    return null;
  }

  if (parent === "apps" && directory === "scripts") {
    const scriptsConfig = path.join(
      repositoryRoot,
      parent,
      workspace,
      directory,
      "tsconfig.json",
    );
    if (ts.sys.fileExists(scriptsConfig)) {
      return scriptsConfig;
    }
  }

  const config = path.join(repositoryRoot, parent, workspace, "tsconfig.json");
  return ts.sys.fileExists(config) ? config : null;
};

const groupChangedFilesByConfig = (
  repositoryRoot: string,
  files: readonly string[],
): Map<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const config = workspaceConfig(repositoryRoot, file);
    if (config === null) {
      continue;
    }
    const group = grouped.get(config) ?? [];
    group.push(file);
    grouped.set(config, group);
  }
  return grouped;
};

export const findResultWorkspaceConfigs = (
  repositoryRoot: string,
): Map<string, undefined> => {
  const configs = new Map<string, undefined>();

  const addConfigWhenDirectoryImportsResult = (directory: string): void => {
    if (!ts.sys.directoryExists(directory)) {
      return;
    }

    const importsResult = ts.sys
      .readDirectory(directory, [".ts", ".tsx"])
      .some((sourceFile) => {
        const relative = path
          .relative(repositoryRoot, sourceFile)
          .replaceAll(path.sep, "/");
        if (!isProductSourcePath(relative)) {
          return false;
        }
        const source = ts.sys.readFile(sourceFile);
        return source !== undefined && RESULT_IMPORT_PATTERN.test(source);
      });
    if (!importsResult) {
      return;
    }

    const config = workspaceConfig(
      repositoryRoot,
      path.join(directory, "result-consumption-discovery.ts"),
    );
    if (config !== null) {
      configs.set(config, undefined);
    }
  };

  addConfigWhenDirectoryImportsResult(path.join(repositoryRoot, "scripts"));

  for (const parent of ["apps", "packages"]) {
    const parentDirectory = path.join(repositoryRoot, parent);
    for (const workspace of ts.sys.getDirectories(parentDirectory)) {
      const workspaceDirectory = path.join(parentDirectory, workspace);
      addConfigWhenDirectoryImportsResult(path.join(workspaceDirectory, "src"));
      if (parent === "apps") {
        addConfigWhenDirectoryImportsResult(
          path.join(workspaceDirectory, "scripts"),
        );
      }
    }
  }
  return configs;
};

const run = (): number => {
  const repositoryRoot = path.resolve(import.meta.dir, "../../..");
  const cli = parseCliOptions();
  const changedFiles =
    cli.mode === "changed"
      ? changedSourceFiles(repositoryRoot, cli.base)
      : undefined;
  if (changedFiles?.length === 0) {
    console.log("result-consumption: no changed product TypeScript files");
    return 0;
  }

  const diagnosticsByLocation = new Map<string, ResultConsumptionDiagnostic>();

  const projects =
    changedFiles === undefined
      ? findResultWorkspaceConfigs(repositoryRoot)
      : groupChangedFilesByConfig(repositoryRoot, changedFiles);

  for (const [configPath, rootNames] of projects) {
    const program =
      rootNames === undefined
        ? createProgram({ configPath })
        : createProgram({ configPath, rootNames });
    const diagnostics =
      rootNames === undefined
        ? scanResultConsumption({ program, repositoryRoot })
        : scanResultConsumption({
            program,
            repositoryRoot,
            sourceFiles: new Set(rootNames),
          });
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.rule}`;
      diagnosticsByLocation.set(key, diagnostic);
    }
  }

  const diagnostics = [...diagnosticsByLocation.values()].sort((a, b) =>
    `${a.file}:${a.line}:${a.column}`.localeCompare(
      `${b.file}:${b.line}:${b.column}`,
    ),
  );
  for (const diagnostic of diagnostics) {
    console.error(
      `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} [${diagnostic.rule}]`,
    );
  }

  if (diagnostics.length > 0) {
    console.error(
      `result-consumption: ${diagnostics.length} violation(s) found.`,
    );
    return 1;
  }

  console.log(`result-consumption: OK (${projects.size} project(s) checked)`);
  return 0;
};

if (import.meta.main) {
  process.exitCode = run();
}

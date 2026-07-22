import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const SOURCE_DIRECTORY = `${path.sep}src${path.sep}`;
const BETTER_RESULT_PACKAGE = `${path.sep}better-result${path.sep}`;
const RESULT_VARIANTS = new Set(["Err", "Ok"]);
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|\/tests\/|\/__tests__\/)/u;
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

  for (const sourceFile of program.getSourceFiles()) {
    if (
      !isProductSourceFile(sourceFile, repositoryRoot) ||
      (sourceFiles !== undefined && !sourceFiles.has(sourceFile.fileName))
    ) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        const discarded = unwrapDiscardedExpression(node.expression);
        if (
          !isAssignmentExpression(discarded) &&
          isResultType(checker.getTypeAtLocation(discarded))
        ) {
          diagnostics.push(
            createDiagnostic({
              node: discarded,
              repositoryRoot,
              rule: "unused-result",
              message:
                "This better-result Result is discarded. Return, assign, yield, or explicitly consume it.",
            }),
          );
        }
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

  const normalized = path.normalize(sourceFile.fileName);
  return (
    normalized.includes(SOURCE_DIRECTORY) &&
    !TEST_FILE_PATTERN.test(normalized.replaceAll(path.sep, "/"))
  );
};

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

const isResultType = (type: ts.Type): boolean => {
  if (type.isUnion()) {
    return type.types.some(isResultType);
  }

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol === undefined || !RESULT_VARIANTS.has(symbol.getName())) {
    return false;
  }

  return symbol.declarations?.some(isBetterResultDeclaration) === true;
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
    signature === undefined ||
    signature.declaration === undefined ||
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
    .filter((file) => /^(?:apps|packages)\/[^/]+\/src\/.*\.tsx?$/u.test(file))
    .filter((file) => !TEST_FILE_PATTERN.test(file))
    .map((file) => path.join(repositoryRoot, file))
    .sort();
};

const workspaceConfig = (
  repositoryRoot: string,
  sourceFile: string,
): string | null => {
  const [parent, workspace] = path
    .relative(repositoryRoot, sourceFile)
    .split(path.sep);
  if (parent === undefined || workspace === undefined) {
    return null;
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
  for (const parent of ["apps", "packages"]) {
    const parentDirectory = path.join(repositoryRoot, parent);
    for (const workspace of ts.sys.getDirectories(parentDirectory)) {
      const workspaceDirectory = path.join(parentDirectory, workspace);
      const sourceDirectory = path.join(workspaceDirectory, "src");
      if (!ts.sys.directoryExists(sourceDirectory)) {
        continue;
      }
      const sourceFiles = ts.sys.readDirectory(sourceDirectory, [
        ".ts",
        ".tsx",
      ]);
      if (
        !sourceFiles.some((sourceFile) => {
          const source = ts.sys.readFile(sourceFile);
          return source !== undefined && RESULT_IMPORT_PATTERN.test(source);
        })
      ) {
        continue;
      }
      const config = path.join(workspaceDirectory, "tsconfig.json");
      if (ts.sys.fileExists(config)) {
        configs.set(config, undefined);
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

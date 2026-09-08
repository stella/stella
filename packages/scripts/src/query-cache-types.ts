import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

import { createProgram } from "./typescript-program";

const CACHE_METHODS = new Set(["getQueryData", "setQueryData"]);
const EXCLUDED_SOURCE =
  /(?:\.d\.ts$|\.gen\.tsx?$|\/generated\/|\.test\.|\.spec\.|\/tests\/|\/__tests__\/|\/e2e\/)/u;

type QueryCacheDiagnostic = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

type ScanQueryCacheOptions = {
  readonly program: ts.Program;
  readonly sourceFiles: readonly ts.SourceFile[];
};

// QueryClient accepts untagged keys and silently infers unknown. Check the actual
// TanStack tag across imports, where the fast oxlint syntax guard cannot follow it.
export const scanQueryCacheTypes = ({
  program,
  sourceFiles,
}: ScanQueryCacheOptions): QueryCacheDiagnostic[] => {
  const checker = program.getTypeChecker();
  const tags = new Map<ts.SourceFile, ts.Type>();
  const diagnostics: QueryCacheDiagnostic[] = [];

  const dataTagType = (sourceFile: ts.SourceFile): ts.Type => {
    const cached = tags.get(sourceFile);
    if (cached !== undefined) {
      return cached;
    }
    const declaration = sourceFile.statements.find(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === "AnyDataTag",
    );
    if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
      panic(`Cannot resolve TanStack AnyDataTag in ${sourceFile.fileName}`);
    }
    const tag = checker.getTypeAtLocation(declaration);
    tags.set(sourceFile, tag);
    return tag;
  };

  const checkCall = (node: ts.CallExpression): void => {
    const callee = node.expression;
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      name = callee.name.text;
    } else if (
      ts.isElementAccessExpression(callee) &&
      ts.isStringLiteralLike(callee.argumentExpression)
    ) {
      name = callee.argumentExpression.text;
    }
    if (name === undefined || !CACHE_METHODS.has(name)) {
      return;
    }
    const declaration = checker.getResolvedSignature(node)?.declaration;
    const owner = declaration?.getSourceFile();
    if (
      !owner?.fileName
        .replaceAll(path.sep, "/")
        .includes("/@tanstack/query-core/")
    ) {
      return;
    }
    const key = node.arguments.at(0);
    if (key === undefined) {
      return;
    }
    const keyType = checker.getTypeAtLocation(key);
    if (
      keyType.flags !== ts.TypeFlags.Any &&
      checker.isTypeAssignableTo(keyType, dataTagType(owner))
    ) {
      return;
    }
    const sourceFile = key.getSourceFile();
    const position = sourceFile.getLineAndCharacterOfPosition(key.getStart());
    diagnostics.push({
      file: sourceFile.fileName,
      line: position.line + 1,
      column: position.character + 1,
      message: `${name} requires a TanStack DataTag key; preserve the queryOptions/infiniteQueryOptions producer's inferred queryKey type.`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      checkCall(node);
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) {
    visit(sourceFile);
  }
  return diagnostics;
};

if (import.meta.main) {
  const repositoryRoot = path.resolve(import.meta.dir, "../../..");
  const webRoot = path.join(repositoryRoot, "apps/web/src/");
  const program = createProgram({
    configPath: path.join(repositoryRoot, "apps/web/tsconfig.json"),
  });
  // Always scan all consumers: changing only an imported producer can erase tags.
  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sourceFile) =>
        sourceFile.fileName.startsWith(webRoot) &&
        !EXCLUDED_SOURCE.test(sourceFile.fileName.replaceAll(path.sep, "/")),
    );
  const diagnostics = scanQueryCacheTypes({ program, sourceFiles });
  for (const diagnostic of diagnostics) {
    console.error(
      `${path.relative(repositoryRoot, diagnostic.file)}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} [query-cache-types]`,
    );
  }
  console.log(
    `query-cache-types: ${diagnostics.length} violation(s), ${sourceFiles.length} source files checked`,
  );
  process.exitCode = diagnostics.length === 0 ? 0 : 1;
}

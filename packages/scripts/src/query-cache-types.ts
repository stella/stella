import { panic } from "better-result";
import path from "node:path";
import * as ts from "tsrs/unstable/ast";
import {
  type Checker,
  type Program,
  type Type,
  TypeFlags,
} from "tsrs/unstable/async";

import { repoRelativePath } from "@stll/portable-path";

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
  readonly program: Program;
  readonly checker: Checker;
  readonly sourceFiles: readonly ts.SourceFile[];
};

// QueryClient accepts untagged keys and silently infers unknown. Check the actual
// TanStack tag across imports, where the fast oxlint syntax guard cannot follow it.
export const scanQueryCacheTypes = async ({
  checker,
  sourceFiles,
}: ScanQueryCacheOptions): Promise<QueryCacheDiagnostic[]> => {
  const tags = new Map<ts.SourceFile, Type>();
  const diagnostics: QueryCacheDiagnostic[] = [];

  const dataTagType = async (sourceFile: ts.SourceFile): Promise<Type> => {
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
    const tag = await checker.getTypeAtLocation(declaration);
    tags.set(sourceFile, tag);
    return tag;
  };

  const checkCall = async (node: ts.CallExpression): Promise<void> => {
    const callee = node.expression;
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      name = callee.name.text;
    } else if (
      ts.isElementAccessExpression(callee) &&
      (ts.isStringLiteral(callee.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(callee.argumentExpression))
    ) {
      name = callee.argumentExpression.text;
    }
    if (name === undefined || !CACHE_METHODS.has(name)) {
      return;
    }
    const declaration = (await checker.getResolvedSignature(node)).declaration;
    const owner = (await declaration?.resolve())?.getSourceFile();
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
    const keyType = await checker.getTypeAtLocation(key);
    if (
      keyType.flags !== TypeFlags.Any &&
      (await checker.isTypeAssignableTo(keyType, await dataTagType(owner)))
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

  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  for (const sourceFile of sourceFiles) {
    visit(sourceFile);
  }
  for (const call of calls) {
    await checkCall(call);
  }
  return diagnostics;
};

if (import.meta.main) {
  const repositoryRoot = path.resolve(import.meta.dir, "../../..");
  const webRoot = path.join(repositoryRoot, "apps/web/src/");
  const opened = await createProgram({
    configPath: path.join(repositoryRoot, "apps/web/tsconfig.json"),
  });
  // Always scan all consumers: changing only an imported producer can erase tags.
  try {
    const sourceFiles: ts.SourceFile[] = [];
    for (const fileName of await opened.program.getSourceFileNames()) {
      if (
        !fileName.startsWith(webRoot) ||
        EXCLUDED_SOURCE.test(fileName.replaceAll(path.sep, "/"))
      ) {
        continue;
      }
      const sourceFile = await opened.program.getSourceFile(fileName);
      if (sourceFile !== undefined) {
        sourceFiles.push(sourceFile);
      }
    }
    const diagnostics = await scanQueryCacheTypes({ ...opened, sourceFiles });
    for (const diagnostic of diagnostics) {
      console.error(
        `${repoRelativePath(repositoryRoot, diagnostic.file)}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message} [query-cache-types]`,
      );
    }
    console.log(
      `query-cache-types: ${diagnostics.length} violation(s), ${sourceFiles.length} source files checked`,
    );
    process.exitCode = diagnostics.length === 0 ? 0 : 1;
  } finally {
    await opened.close();
  }
}

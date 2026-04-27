import { Result } from "better-result";

import { SandboxError } from "@/api/lib/errors/tagged-errors";

let transpiler: Bun.Transpiler | undefined;

const getTranspiler = (): Bun.Transpiler => {
  transpiler ??= new Bun.Transpiler({ loader: "ts", target: "browser" });
  return transpiler;
};

const buildSandboxSyntaxProbe = (rawCode: string): string =>
  `async function __sandbox__() {\n${rawCode}\n}`;

const buildSandboxTransformSource = (rawCode: string): string =>
  `(async () => {\n${rawCode}\n})()`;

const messageForImportKind = (kind: Bun.ImportKind): string => {
  switch (kind) {
    case "import-statement":
      return "Import statements are not allowed in the sandbox";
    case "require-call":
      return "Require() is not allowed in the sandbox";
    case "require-resolve":
      return "Require.resolve() is not allowed in the sandbox";
    case "dynamic-import":
      return "Dynamic import() is not allowed in the sandbox";
    case "import-rule":
      return "CSS @import rules are not allowed in the sandbox";
    case "url-token":
      return "Url() references are not allowed in the sandbox";
    case "internal":
      return "Internal module references are not allowed in the sandbox";
    case "entry-point-run":
      return "Entry-point run imports are not allowed in the sandbox";
    case "entry-point-build":
      return "Entry-point build imports are not allowed in the sandbox";
    default:
      return "Module loading is not allowed in the sandbox";
  }
};

const isUnexpectedExportError = (cause: unknown): boolean =>
  String(cause).includes("Unexpected export");

export const transpileSandboxSource = (
  rawCode: string,
): Result<string, SandboxError> =>
  Result.gen(function* () {
    const imports = yield* Result.try({
      try: () => getTranspiler().scanImports(rawCode),
      catch: (cause) =>
        new SandboxError({
          reason: "transpile",
          message: "Failed to scan imports in code passed to the sandbox",
          cause,
        }),
    });

    const firstImport = imports.at(0);
    if (firstImport) {
      return Result.err(
        new SandboxError({
          reason: "forbidden-syntax",
          message: messageForImportKind(firstImport.kind),
        }),
      );
    }

    const scanResult = yield* Result.try({
      try: () => getTranspiler().scan(buildSandboxSyntaxProbe(rawCode)),
      catch: (cause) =>
        isUnexpectedExportError(cause)
          ? new SandboxError({
              reason: "forbidden-syntax",
              message: "Export statements are not allowed in the sandbox",
            })
          : new SandboxError({
              reason: "transpile",
              message: "Failed to scan code passed to the sandbox",
              cause,
            }),
    });

    if (scanResult.exports.length > 0) {
      return Result.err(
        new SandboxError({
          reason: "forbidden-syntax",
          message: "Export statements are not allowed in the sandbox",
        }),
      );
    }

    return Result.try({
      try: () =>
        getTranspiler().transformSync(buildSandboxTransformSource(rawCode)),
      catch: (cause) =>
        new SandboxError({
          reason: "transpile",
          message: "Failed to transform code passed to the sandbox",
          cause,
        }),
    });
  });

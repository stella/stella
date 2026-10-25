// The TypeScript program the web API type printer reads: built by tsrs, the
// Rust port of the TypeScript 7 compiler, in its own process and queried
// through the TypeScript 7 API it serves.
//
// The program's roots are the contract and the files served from memory. A
// package's entry is resolved from the contract, as the API itself resolves
// it, so the printer reads what that entry exports.
import { panic, Result } from "better-result";
import path from "node:path";
import type { SourceFile } from "tsrs/unstable/ast";
import {
  API,
  type Checker,
  type Diagnostic,
  type Symbol as CompilerSymbol,
} from "tsrs/unstable/async";

import { repoRelativePath } from "@stll/portable-path";

import {
  type CompilerInputRecorder,
  serveVirtualFiles,
} from "./compiler-input-stamp";

const PROGRAM_CONFIG_NAME = "tsconfig.__web-api-program__.json";

export type ContractProgram = {
  checker: Checker;
  contractSource: SourceFile;
  /** The file a declaration handle names, spelled as on disk. */
  fileNameOf: (declarationPath: string) => string;
  /** The module symbol of a package entry, as the contract resolves it. */
  moduleOfPackage: (packageName: string) => Promise<CompilerSymbol | undefined>;
  /** Syntactic and semantic diagnostics of the given program files. */
  diagnosticsOf: (fileNames: readonly string[]) => Promise<Diagnostic[]>;
  close: () => Promise<void>;
};

type OpenContractProgramOptions = {
  contractPath: string;
  /** The tsconfig the program extends, and whose declaration files it adds. */
  baseConfigPath?: string;
  compilerOptions: Record<string, unknown>;
  /** Files served from memory, added to the program's roots. */
  virtualFiles: ReadonlyMap<string, string>;
  recorder?: CompilerInputRecorder;
};

// On a case-insensitive file system the compiler keys files by a lower-cased
// path; declaration handles carry that key, not the spelling on disk.
const fileNameResolver = (fileNames: readonly string[]) => {
  const byPath = new Map<string, string>();
  for (const fileName of fileNames) {
    byPath.set(fileName.toLowerCase(), fileName);
  }
  for (const fileName of fileNames) {
    byPath.set(fileName, fileName);
  }
  return (declarationPath: string) =>
    byPath.get(declarationPath) ??
    byPath.get(declarationPath.toLowerCase()) ??
    panic(`web-api-program: ${declarationPath} is not a program file`);
};

export const openContractProgram = async ({
  contractPath,
  baseConfigPath,
  compilerOptions,
  virtualFiles,
  recorder,
}: OpenContractProgramOptions): Promise<ContractProgram> => {
  const directory = path.dirname(contractPath);
  const configPath = path.join(directory, PROGRAM_CONFIG_NAME);
  // Served live: the config is written once the base config's files are known.
  const served = new Map(virtualFiles);
  served.set(configPath, "{}");
  const api = new API({
    cwd: directory,
    fs:
      recorder === undefined
        ? serveVirtualFiles(served)
        : recorder.fileSystem(served),
  });
  const opened = await Result.tryPromise(async () => {
    // Ambient declarations (asset modules) the API sources rely on.
    const ambient =
      baseConfigPath === undefined
        ? []
        : (await api.parseConfigFile(baseConfigPath)).fileNames.filter(
            (fileName) => fileName.endsWith(".d.ts"),
          );
    served.set(
      configPath,
      JSON.stringify({
        ...(baseConfigPath === undefined
          ? {}
          : { extends: `./${repoRelativePath(directory, baseConfigPath)}` }),
        compilerOptions,
        files: [contractPath, ...virtualFiles.keys(), ...ambient],
        include: [],
      }),
    );
    const snapshot = await api.createSnapshot({ openProjects: [configPath] });
    const project =
      snapshot.getConfiguredProject(configPath) ??
      panic("web-api-program: the program config did not open");
    const configDiagnostics =
      await project.program.getConfigFileParsingDiagnostics();
    if (configDiagnostics.length > 0) {
      return panic(
        `web-api-program: ${configDiagnostics.map(({ text }) => text).join("; ")}`,
      );
    }
    const resolver = await api.createModuleResolver(
      project.parsedCommandLine.options,
    );
    return { project, resolver, snapshot };
  });
  if (opened.isErr()) {
    await api.close();
    return panic("web-api-program: could not open the program", opened.error);
  }
  const { project, resolver, snapshot } = opened.value;
  const { checker, program } = project;
  const contractSource =
    (await program.getSourceFile(contractPath)) ??
    panic(`web-api-program: ${contractPath} is not in the program`);
  const modules = new Map<string, Promise<CompilerSymbol | undefined>>();
  // A package whose entry the program never loaded exports nothing to it.
  const resolveModule = async (packageName: string) => {
    const resolved = await resolver.resolveModuleName(
      packageName,
      directory,
      undefined,
      { snapshot },
    );
    const fileName = resolved.resolvedModule?.resolvedFileName;
    const source =
      fileName === undefined
        ? undefined
        : await program.getSourceFile(fileName);
    return source === undefined
      ? undefined
      : await checker.getSymbolAtLocation(source);
  };
  return {
    checker,
    contractSource,
    fileNameOf: fileNameResolver(await program.getSourceFileNames()),
    moduleOfPackage: async (packageName) => {
      const known = modules.get(packageName);
      if (known !== undefined) {
        return await known;
      }
      const resolving = resolveModule(packageName);
      modules.set(packageName, resolving);
      return await resolving;
    },
    diagnosticsOf: async (fileNames) => [
      ...(await program.getSyntacticDiagnostics(fileNames)),
      ...(await program.getSemanticDiagnostics(fileNames)),
    ],
    close: async () => {
      await api.close();
    },
  };
};

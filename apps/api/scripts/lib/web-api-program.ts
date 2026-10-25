// The TypeScript 7 program the web API type printer reads: built by the
// compiler's own process (tsgo) and queried through its API, so the printer
// and the identity check run on the checker apps/web type-checks with.
//
// The program's roots are the contract, the files served from memory and a
// package probe beside the contract: one `import type` per apps/web dependency
// the program already loads, so the printer can read what each package entry
// exports, resolved from the contract as the API itself resolves it.
import { panic, Result } from "better-result";
import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import { isImportDeclaration } from "typescript/unstable/ast/is";
import {
  API,
  type Checker,
  type Diagnostic,
  type Project,
  type Symbol as CompilerSymbol,
} from "typescript/unstable/async";

import { repoRelativePath } from "@stll/portable-path";

import {
  type CompilerInputRecorder,
  serveVirtualFiles,
} from "./compiler-input-stamp";

const PROGRAM_CONFIG_NAME = "tsconfig.__web-api-program__.json";
const PACKAGE_PROBE_NAME = "__web-api-packages__.ts";

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
  packageOf: (fileName: string) => string | undefined;
  webDependencies: ReadonlySet<string>;
};

const probeSource = (packages: readonly string[]) =>
  `${packages
    .map(
      (name, index) =>
        `import type * as __package${index} from ${JSON.stringify(name)};\n`,
    )
    .join("")}export {};\n`;

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
  packageOf,
  webDependencies,
}: OpenContractProgramOptions): Promise<ContractProgram> => {
  const directory = path.dirname(contractPath);
  const configPath = path.join(directory, PROGRAM_CONFIG_NAME);
  const probePath = path.join(directory, PACKAGE_PROBE_NAME);
  // Served live: the config and the probe are rewritten once the files they
  // depend on are known.
  const served = new Map(virtualFiles);
  served.set(configPath, "{}");
  served.set(probePath, probeSource([]));
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
        files: [contractPath, probePath, ...virtualFiles.keys(), ...ambient],
        include: [],
      }),
    );
    const loaded = await api.updateSnapshot({ openProjects: [configPath] });
    const loadedProject =
      loaded.getProject(configPath) ??
      panic("web-api-program: the program config did not open");
    const configDiagnostics =
      await loadedProject.program.getConfigFileParsingDiagnostics();
    if (configDiagnostics.length > 0) {
      return panic(
        `web-api-program: ${configDiagnostics.map(({ text }) => text).join("; ")}`,
      );
    }
    const packages = [
      ...new Set(
        (await loadedProject.program.getSourceFileNames()).flatMap(
          (fileName) => {
            const name = packageOf(fileName);
            return name !== undefined && webDependencies.has(name)
              ? [name]
              : [];
          },
        ),
      ),
    ].toSorted();
    served.set(probePath, probeSource(packages));
    const snapshot = await api.updateSnapshot({
      fileChanges: { changed: [probePath] },
    });
    await loaded.dispose();
    const project: Project =
      snapshot.getProject(configPath) ??
      panic("web-api-program: the program config did not reopen");
    return { packages, project };
  });
  if (opened.isErr()) {
    await api.close();
    return panic("web-api-program: could not open the program", opened.error);
  }
  const { packages, project } = opened.value;
  const { checker, program } = project;
  const contractSource =
    (await program.getSourceFile(contractPath)) ??
    panic(`web-api-program: ${contractPath} is not in the program`);
  const probe =
    (await program.getSourceFile(probePath)) ??
    panic("web-api-program: the package probe is not in the program");
  const specifiers = probe.statements.flatMap((statement) =>
    isImportDeclaration(statement) ? [statement.moduleSpecifier] : [],
  );
  const modules = new Map<string, Promise<CompilerSymbol | undefined>>();
  return {
    checker,
    contractSource,
    fileNameOf: fileNameResolver(await program.getSourceFileNames()),
    moduleOfPackage: async (packageName) => {
      const index = packages.indexOf(packageName);
      const specifier = specifiers.at(index);
      if (index === -1 || specifier === undefined) {
        return undefined;
      }
      const known = modules.get(packageName);
      if (known !== undefined) {
        return await known;
      }
      const resolved = checker.getSymbolAtLocation(specifier);
      modules.set(packageName, resolved);
      return await resolved;
    },
    diagnosticsOf: async (fileNames) => {
      const diagnostics: Diagnostic[] = [];
      for (const fileName of fileNames) {
        diagnostics.push(
          ...(await program.getSyntacticDiagnostics(fileName)),
          ...(await program.getSemanticDiagnostics(fileName)),
        );
      }
      return diagnostics;
    },
    close: async () => {
      await api.close();
    },
  };
};

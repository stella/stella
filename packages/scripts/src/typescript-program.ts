import { panic, Result } from "better-result";
import path from "node:path";
import { API } from "tsrs/unstable/async";
import { serverFS } from "tsrs/unstable/fs";

type CreateProgramOptions = {
  readonly configPath?: string;
  readonly rootNames?: readonly string[];
  readonly virtualFiles?: ReadonlyMap<string, string>;
  /** JSON tsconfig options, including string-valued target and module kinds. */
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
};

export const createProgram = async ({
  configPath,
  rootNames,
  virtualFiles,
  compilerOptions,
}: CreateProgramOptions) => {
  const directory =
    configPath === undefined ? process.cwd() : path.dirname(configPath);
  const virtualPath = path.join(directory, "tsconfig.__script-program__.json");
  let configText = "{}";
  const api = new API({
    cwd: directory,
    fs: {
      readFile: (fileName) =>
        fileName === virtualPath
          ? configText
          : (virtualFiles?.get(fileName) ?? serverFS.useOS),
      fileExists: (fileName) =>
        fileName === virtualPath || virtualFiles?.has(fileName) === true
          ? true
          : serverFS.useOS,
      directoryExists: serverFS.useOS,
      getAccessibleEntries: serverFS.useOS,
      realpath: (fileName) =>
        fileName === virtualPath || virtualFiles?.has(fileName) === true
          ? serverFS.identity
          : serverFS.useOS,
      stat: serverFS.useOS,
      writeFile: serverFS.error,
      removeFile: serverFS.error,
    },
  });
  const opened = await Result.tryPromise(async () => {
    const parsed =
      configPath === undefined
        ? undefined
        : await api.parseConfigFile(configPath);
    if (parsed !== undefined && parsed.errors.length > 0) {
      panic(parsed.errors.map(({ text }) => text).join("\n"));
    }
    if (configPath === undefined && rootNames === undefined) {
      panic("A script program requires a config path or root names");
    }
    const files =
      rootNames === undefined
        ? parsed?.fileNames
        : [
            ...rootNames,
            ...(parsed?.fileNames.filter((file) => file.endsWith(".d.ts")) ??
              []),
          ];
    configText = JSON.stringify({
      ...(configPath === undefined ? {} : { extends: configPath }),
      ...(compilerOptions === undefined ? {} : { compilerOptions }),
      files,
      include: [],
      ...(parsed?.projectReferences === undefined
        ? {}
        : {
            references: parsed.projectReferences.map(
              ({ path: referencePath }) => ({ path: referencePath }),
            ),
          }),
    });
    const snapshot = await api.createSnapshot({ openProjects: [virtualPath] });
    const project =
      snapshot.getConfiguredProject(virtualPath) ??
      panic("The script program config did not open");
    const errors = await project.program.getConfigFileParsingDiagnostics();
    if (errors.length > 0) {
      panic(errors.map(({ text }) => text).join("\n"));
    }
    return project;
  });
  if (opened.isErr()) {
    await api.close();
    return panic("Could not open the script program", opened.error);
  }
  return {
    program: opened.value.program,
    checker: opened.value.checker,
    close: async () => {
      await api.close();
    },
  };
};

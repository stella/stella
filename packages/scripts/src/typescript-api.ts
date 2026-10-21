import { Result, TaggedError, type Result as ResultType } from "better-result";
import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import {
  API,
  type Checker,
  type Program,
  type Snapshot,
} from "typescript/unstable/async";
import {
  createVirtualFileSystem,
  type FileSystem,
} from "typescript/unstable/fs";

export class TypeScriptApiError extends TaggedError("TypeScriptApiError")<{
  message: string;
  capability: string;
  cause?: unknown;
}> {}

const memoryFileSystem = createVirtualFileSystem({});
const virtualFiles = new Set<string>();
const virtualDirectories = new Set<string>();
const virtualFileSystem: FileSystem = {
  readFile: (fileName) =>
    virtualFiles.has(fileName)
      ? memoryFileSystem.readFile?.(fileName)
      : undefined,
  fileExists: (fileName) =>
    virtualFiles.has(fileName)
      ? memoryFileSystem.fileExists?.(fileName)
      : undefined,
  directoryExists: (directoryName) =>
    virtualDirectories.has(directoryName)
      ? memoryFileSystem.directoryExists?.(directoryName)
      : undefined,
  getAccessibleEntries: (directoryName) =>
    virtualDirectories.has(directoryName)
      ? memoryFileSystem.getAccessibleEntries?.(directoryName)
      : undefined,
  realpath: (fileName) =>
    virtualFiles.has(fileName) || virtualDirectories.has(fileName)
      ? memoryFileSystem.realpath?.(fileName)
      : undefined,
  writeFile: (fileName, text) => {
    virtualFiles.add(fileName);
    let directoryName = path.dirname(fileName);
    while (!virtualDirectories.has(directoryName)) {
      virtualDirectories.add(directoryName);
      const parentDirectory = path.dirname(directoryName);
      if (parentDirectory === directoryName) {
        break;
      }
      directoryName = parentDirectory;
    }
    memoryFileSystem.writeFile?.(fileName, text);
  },
  removeFile: (fileName) => {
    virtualFiles.delete(fileName);
    memoryFileSystem.removeFile?.(fileName);
  },
};
const sourceProjects = new Map<string, string>();
let apiPromise: Promise<API> | undefined;
let closePromise: Promise<void> | undefined;
let operationQueue: Promise<void> = Promise.resolve();
let virtualProjectId = 0;

const closeApi = async () => {
  if (closePromise !== undefined) {
    return closePromise;
  }
  closePromise =
    apiPromise?.then(async (api) => api.close()) ?? Promise.resolve();
  return closePromise;
};

const api = async () => {
  if (apiPromise === undefined) {
    apiPromise = Promise.resolve(new API({ fs: virtualFileSystem }));
    process.once("beforeExit", () => {
      closePromise = closeApi();
    });
  }
  return apiPromise;
};

const failure = (capability: string, cause: unknown) =>
  new TypeScriptApiError({
    message: `TypeScript 7 could not provide ${capability}.`,
    capability,
    cause,
  });

const tryApi = async <T>(capability: string, operation: () => Promise<T>) =>
  Result.tryPromise({
    try: operation,
    catch: (cause) => failure(capability, cause),
  });

const enqueue = async <T>(operation: () => Promise<T>) => {
  const previous = operationQueue;
  let release: (() => void) | undefined;
  operationQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  return operation().finally(() => release?.());
};

const writeVirtualFile = (fileName: string, text: string) => {
  virtualFileSystem.writeFile?.(fileName, text);
};

const sourceResult = async (
  snapshot: Snapshot,
  configPath: string,
  fileName: string,
): Promise<ResultType<SourceFile, TypeScriptApiError>> => {
  const project = snapshot.getProject(configPath);
  if (project === undefined) {
    return Result.err(
      failure(`a project containing the source file ${fileName}`, undefined),
    );
  }
  const source = await project.program.getSourceFile(fileName);
  return source === undefined
    ? Result.err(failure(`the parsed source file ${fileName}`, undefined))
    : Result.ok(source);
};

export const parseSource = async (fileName: string, text: string) => {
  const absoluteFileName = path.resolve(fileName);
  const configPath =
    sourceProjects.get(absoluteFileName) ??
    path.join(
      path.dirname(absoluteFileName),
      `.stella-parse-source-${process.pid}-${virtualProjectId++}.json`,
    );
  sourceProjects.set(absoluteFileName, configPath);
  writeVirtualFile(absoluteFileName, text);
  writeVirtualFile(configPath, JSON.stringify({ files: [absoluteFileName] }));
  return tryApi(`the parser for ${absoluteFileName}`, async () =>
    enqueue(async () => {
      const client = await api();
      client.clearSourceFileCache();
      const snapshot = await client.updateSnapshot({
        openProjects: [configPath],
        fileChanges: { changed: [absoluteFileName] },
      });
      return sourceResult(snapshot, configPath, absoluteFileName);
    }),
  ).then((result) => (result.status === "ok" ? result.value : result));
};

export const parseTsconfig = async (configPath: string) =>
  tryApi(`tsconfig parsing for ${configPath}`, async () =>
    enqueue(async () => {
      const client = await api();
      return client.parseConfigFile(path.resolve(configPath));
    }),
  );

export type OpenProgramInput =
  | { configPath: string; roots?: never }
  | { configPath?: never; roots: readonly string[] };

export type OpenProgram = {
  program: Program;
  checker: Checker;
  snapshot: Snapshot;
};

export const openProgram = async (input: OpenProgramInput) =>
  tryApi("a TypeScript program and checker", async () =>
    enqueue(async (): Promise<OpenProgram> => {
      const client = await api();
      if (input.configPath !== undefined) {
        const configPath = path.resolve(input.configPath);
        const snapshot = await client.updateSnapshot({
          openProjects: [configPath],
        });
        const project = snapshot.getProject(configPath);
        if (project === undefined) {
          throw failure(`the configured project ${configPath}`, undefined);
        }
        return { program: project.program, checker: project.checker, snapshot };
      }

      const firstRoot = input.roots.at(0);
      if (firstRoot === undefined) {
        throw failure("a program from an empty root list", undefined);
      }
      const roots = input.roots.map((root) => path.resolve(root));
      const configPath = path.join(
        path.dirname(path.resolve(firstRoot)),
        `.stella-typescript-api-${process.pid}-${virtualProjectId++}.json`,
      );
      writeVirtualFile(configPath, JSON.stringify({ files: roots }));
      const snapshot = await client.updateSnapshot({
        openProjects: [configPath],
      });
      const project = snapshot.getProject(configPath);
      if (project === undefined) {
        throw failure(`the root-file project ${configPath}`, undefined);
      }
      return { program: project.program, checker: project.checker, snapshot };
    }),
  );

export const unsupportedTypeScriptCapability = (capability: string) =>
  Result.err(failure(capability, undefined));

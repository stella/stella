import { Result, type Result as ResultType, TaggedError } from "better-result";
import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import { API, type Snapshot } from "typescript/unstable/async";
import type { FileSystem } from "typescript/unstable/fs";

export class TypeScriptApiError extends TaggedError("TypeScriptApiError")<{
  message: string;
  capability: string;
  cause?: unknown;
}> {}

type SourceText = {
  readonly fileName: string;
  readonly text: string;
};

export type ParsedSources = {
  /** The one snapshot every requested file was parsed in. */
  readonly snapshot: Snapshot;
  /** Parsed files, in the order they were requested. */
  readonly sourceFiles: readonly SourceFile[];
};

export type TypeScriptSession = {
  readonly parseSources: (
    sources: readonly SourceText[],
  ) => Promise<ResultType<ParsedSources, TypeScriptApiError>>;
};

const failure = (capability: string, cause?: unknown) =>
  new TypeScriptApiError({
    message: `TypeScript 7 could not provide ${capability}.`,
    capability,
    cause,
  });

// Parsing only: no default library and no import resolution, so a snapshot
// holds exactly the requested files.
const PARSE_ONLY_OPTIONS = { noLib: true, noResolve: true, types: [] };

/**
 * In-memory files layered over the real file system: paths the overlay does
 * not hold return `undefined`, which falls through to disk.
 */
const createOverlay = () => {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const fileSystem: FileSystem = {
    readFile: (fileName) => files.get(fileName),
    fileExists: (fileName) => (files.has(fileName) ? true : undefined),
    directoryExists: (directoryName) =>
      directories.has(directoryName) ? true : undefined,
    realpath: (fileName) =>
      files.has(fileName) || directories.has(fileName) ? fileName : undefined,
  };
  const write = (fileName: string, text: string) => {
    files.set(fileName, text);
    let directoryName = path.dirname(fileName);
    while (!directories.has(directoryName)) {
      directories.add(directoryName);
      const parentDirectory = path.dirname(directoryName);
      if (parentDirectory === directoryName) {
        break;
      }
      directoryName = parentDirectory;
    }
  };
  return { fileSystem, write };
};

/**
 * Runs `run` with one TypeScript 7 API session and always closes it, whether
 * `run` returns or throws. A failed close is reported as an error result.
 */
export const withTypeScriptSession = async <T>(
  run: (session: TypeScriptSession) => Promise<T>,
): Promise<ResultType<T, TypeScriptApiError>> => {
  const overlay = createOverlay();
  const started = Result.try({
    try: () => new API({ fs: overlay.fileSystem }),
    catch: (cause) => failure("an API session", cause),
  });
  if (started.status === "error") {
    return started;
  }
  const client = started.value;
  let projectCount = 0;
  let closed = false;

  const parseSources = async (
    sources: readonly SourceText[],
  ): Promise<ResultType<ParsedSources, TypeScriptApiError>> => {
    // A call after close would silently start a new API process.
    if (closed) {
      return Result.err(failure("a parse after the session closed"));
    }
    const fileNames = sources.map((source) => {
      const fileName = path.resolve(source.fileName);
      overlay.write(fileName, source.text);
      return fileName;
    });
    const firstFileName = fileNames.at(0);
    if (firstFileName === undefined) {
      return Result.err(failure("a parse of an empty source list"));
    }
    projectCount += 1;
    const configPath = path.join(
      path.dirname(firstFileName),
      `.stella-parse-sources-${process.pid}-${projectCount}.json`,
    );
    overlay.write(
      configPath,
      JSON.stringify({ compilerOptions: PARSE_ONLY_OPTIONS, files: fileNames }),
    );
    const capability = `a parse of ${fileNames.length} source file(s)`;
    const opened = await Result.tryPromise({
      try: async () =>
        client.updateSnapshot({
          openProjects: [configPath],
          fileChanges: { changed: fileNames },
        }),
      catch: (cause) => failure(capability, cause),
    });
    if (opened.status === "error") {
      return opened;
    }
    const snapshot = opened.value;
    const project = snapshot.getProject(configPath);
    if (project === undefined) {
      return Result.err(failure(capability));
    }
    const loaded = await Result.tryPromise({
      try: async () =>
        Promise.all(
          fileNames.map(async (fileName) =>
            project.program.getSourceFile(fileName),
          ),
        ),
      catch: (cause) => failure(capability, cause),
    });
    if (loaded.status === "error") {
      return loaded;
    }
    const sourceFiles: SourceFile[] = [];
    for (const sourceFile of loaded.value) {
      if (sourceFile === undefined) {
        return Result.err(failure(capability));
      }
      sourceFiles.push(sourceFile);
    }
    return Result.ok({ snapshot, sourceFiles });
  };

  const close = async () => {
    closed = true;
    return Result.tryPromise({
      try: async () => client.close(),
      catch: (cause) => failure("a closed API session", cause),
    });
  };

  try {
    const value = await run({ parseSources });
    const closing = await close();
    return closing.status === "error" ? closing : Result.ok(value);
  } catch (error) {
    const closing = await close();
    if (closing.status === "error") {
      // Both failures stay visible: the run's error and the failed close.
      throw new TypeScriptApiError({
        message:
          "TypeScript 7 session run failed and the session could not close.",
        capability: closing.error.capability,
        cause: { run: error, close: closing.error },
      });
    }
    throw error;
  }
};

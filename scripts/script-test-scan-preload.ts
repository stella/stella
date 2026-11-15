import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logPath = process.env["SCRIPT_TEST_SCAN_LOG"];

type ScanRecord = {
  readonly directory: string;
  readonly pattern?: string;
};

const writeScan = (record: ScanRecord) => {
  if (logPath !== undefined) {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  }
};

const directoryName = (value: unknown): string => {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }
  return typeof value === "string" || value instanceof Buffer
    ? value.toString()
    : ".";
};

const resolvedDirectoryName = (value: unknown): string =>
  path.resolve(process.cwd(), directoryName(value));

const installDirectoryWrapper = (
  owner: object,
  name: string,
  wrapped: unknown,
) => {
  Object.defineProperty(owner, name, {
    configurable: true,
    value: wrapped,
  });
};

/**
 * Every node:fs API that enumerates a directory, sync, callback and promise
 * forms. A test that lists a directory through any of them leaves a scan
 * record; a census test keeps this table complete.
 */
export const DIRECTORY_SCAN_APIS = {
  fs: ["readdir", "readdirSync", "opendir", "opendirSync"],
  promises: ["readdir", "opendir"],
} as const;

/** The node:fs glob APIs: a pattern (or patterns) scanned from `cwd`. */
export const GLOB_SCAN_APIS = {
  fs: ["glob", "globSync"],
  promises: ["glob"],
} as const;

const wrapScanApi = (owner: object, name: string) => {
  const original: unknown = Reflect.get(owner, name);
  if (typeof original !== "function") {
    return;
  }
  installDirectoryWrapper(
    owner,
    name,
    function (this: unknown, ...args: unknown[]): unknown {
      writeScan({ directory: resolvedDirectoryName(args[0]) });
      return Reflect.apply(original, this, args);
    },
  );
};
for (const name of DIRECTORY_SCAN_APIS.fs) {
  wrapScanApi(fs, name);
}
for (const name of DIRECTORY_SCAN_APIS.promises) {
  wrapScanApi(fs.promises, name);
}

const globCwd = (options: unknown): string =>
  typeof options === "object" &&
  options !== null &&
  "cwd" in options &&
  options.cwd !== undefined
    ? resolvedDirectoryName(options.cwd)
    : process.cwd();

const wrapGlobApi = (owner: object, name: string) => {
  const original: unknown = Reflect.get(owner, name);
  if (typeof original !== "function") {
    return;
  }
  installDirectoryWrapper(
    owner,
    name,
    function (this: unknown, ...args: unknown[]): unknown {
      const directory = globCwd(args[1]);
      const patterns = Array.isArray(args[0]) ? args[0] : [args[0]];
      for (const pattern of patterns) {
        writeScan(
          typeof pattern === "string" ? { directory, pattern } : { directory },
        );
      }
      return Reflect.apply(original, this, args);
    },
  );
};
for (const name of GLOB_SCAN_APIS.fs) {
  wrapGlobApi(fs, name);
}
for (const name of GLOB_SCAN_APIS.promises) {
  wrapGlobApi(fs.promises, name);
}

const globDirectory = (value: unknown): string => {
  if (typeof value === "string" || value instanceof URL) {
    return resolvedDirectoryName(value);
  }
  if (typeof value === "object" && value !== null && "cwd" in value) {
    return resolvedDirectoryName(value.cwd);
  }
  return process.cwd();
};

type ScanOptions = Parameters<Bun.Glob["scan"]>[0];

// Every glob a test builds records its pattern and where it scans, then
// scans exactly as Bun's own would.
class ScanRecordingGlob extends Bun.Glob {
  readonly #pattern: string;

  constructor(pattern: string) {
    super(pattern);
    this.#pattern = pattern;
  }

  override scan(options?: ScanOptions) {
    writeScan({
      directory: globDirectory(options),
      pattern: this.#pattern,
    });
    return super.scan(options);
  }

  override scanSync(options?: ScanOptions) {
    writeScan({
      directory: globDirectory(options),
      pattern: this.#pattern,
    });
    return super.scanSync(options);
  }
}
Bun.Glob = ScanRecordingGlob;

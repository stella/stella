import fs from "node:fs";
import path from "node:path";

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
    return value.pathname;
  }
  return typeof value === "string" || value instanceof Buffer
    ? value.toString()
    : ".";
};

const resolvedDirectoryName = (value: unknown): string =>
  path.resolve(process.cwd(), directoryName(value));

const wrapDirectoryFunction = <Arguments extends unknown[], Result>(
  original: (...args: Arguments) => Result,
) =>
  function (this: unknown, ...args: Arguments): Result {
    writeScan({ directory: resolvedDirectoryName(args[0]) });
    return original.apply(this, args);
  };

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

installDirectoryWrapper(
  fs,
  "readdirSync",
  wrapDirectoryFunction(fs.readdirSync),
);
installDirectoryWrapper(fs, "readdir", wrapDirectoryFunction(fs.readdir));
installDirectoryWrapper(
  fs,
  "opendirSync",
  wrapDirectoryFunction(fs.opendirSync),
);
installDirectoryWrapper(fs, "opendir", wrapDirectoryFunction(fs.opendir));
installDirectoryWrapper(
  fs.promises,
  "readdir",
  wrapDirectoryFunction(fs.promises.readdir),
);

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

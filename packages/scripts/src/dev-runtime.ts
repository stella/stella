import { panic } from "better-result";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { DEV_MODES, type DevMode } from "./dev-runner-config";

// Machine-readable state of a running dev runner. Scripts and agents read the
// live URLs from here instead of scraping the console summary, which moves
// whenever the runner shifts to free ports. Lives under the checkout root and
// is gitignored.
export const DEV_STATE_DIR = ".stella-dev";
const RUNTIME_FILE = "runtime.json";

export type DevRuntime = {
  apiUrl: string | null;
  dockerProject: string | null;
  infraOffset: number;
  mode: DevMode;
  pid: number;
  seeded: boolean;
  startedAt: string;
  webUrl: string | null;
};

export const devStatePath = (rootDir: string, fileName: string) =>
  path.join(rootDir, DEV_STATE_DIR, fileName);

const runtimePath = (rootDir: string) => devStatePath(rootDir, RUNTIME_FILE);

export const writeDevRuntime = (rootDir: string, runtime: DevRuntime) => {
  mkdirSync(path.join(rootDir, DEV_STATE_DIR), { recursive: true });
  writeFileSync(runtimePath(rootDir), `${JSON.stringify(runtime, null, 2)}\n`);
};

// Only the runner that wrote the file removes it, so a runner that failed to
// start never deletes the state of the one still serving this checkout.
export const removeDevRuntime = (rootDir: string, pid: number) => {
  if (readDevRuntime(rootDir)?.pid === pid) {
    rmSync(runtimePath(rootDir), { force: true });
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown) =>
  value === null || typeof value === "string";

const isDevMode = (value: unknown): value is DevMode =>
  DEV_MODES.some((mode) => mode === value);

const parseDevRuntime = (value: unknown): DevRuntime | null => {
  if (
    !isRecord(value) ||
    !isNullableString(value["apiUrl"]) ||
    !isNullableString(value["dockerProject"]) ||
    typeof value["infraOffset"] !== "number" ||
    !isDevMode(value["mode"]) ||
    typeof value["pid"] !== "number" ||
    typeof value["seeded"] !== "boolean" ||
    typeof value["startedAt"] !== "string" ||
    !isNullableString(value["webUrl"])
  ) {
    return null;
  }
  return {
    apiUrl: value["apiUrl"],
    dockerProject: value["dockerProject"],
    infraOffset: value["infraOffset"],
    mode: value["mode"],
    pid: value["pid"],
    seeded: value["seeded"],
    startedAt: value["startedAt"],
    webUrl: value["webUrl"],
  };
};

export const readDevRuntime = (rootDir: string): DevRuntime | null => {
  const filePath = runtimePath(rootDir);
  if (!existsSync(filePath)) {
    return null;
  }
  const runtime = parseDevRuntime(JSON.parse(readFileSync(filePath, "utf-8")));
  if (runtime === null) {
    // The runner in this package is the only writer; a shape it does not
    // produce means a stale file from an incompatible version.
    panic(`${filePath} has an unexpected shape; delete it and restart`);
  }
  return runtime;
};

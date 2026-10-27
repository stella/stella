// Bun test preload for the flaky-test quarantine.
//
// CI test steps load it through BUN_OPTIONS=--preload=<this file> and set
// FLAKY_TEST_QUARANTINE_REPORT_DIR; without that directory, or outside a test
// file, it does nothing. A test named in scripts/flaky-test-quarantine.json
// still runs, but its body is wrapped: a throw, rejection or timeout is
// recorded in the report directory and printed as `(quarantined fail)`
// instead of failing the process, so the package task, the commands chained
// after it and the rest of the Turbo run proceed. Every other test is
// registered untouched.
//
// Reach: plain `test`/`it` calls and their `only`, `concurrent` and `serial`
// forms, named by their `describe` path. Hooks, `expect.assertions` counts and
// table forms (`test.each`) stay outside the wrapper; an entry that matches no
// registration in a file that ran is reported as stale.

import * as bunTest from "bun:test";
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { inspect, stripVTControlCharacters } from "node:util";

const QUARANTINE_REPORT_DIR_ENV = "FLAKY_TEST_QUARANTINE_REPORT_DIR";
const QUARANTINE_REGISTRY_ENV = "FLAKY_TEST_QUARANTINE_REGISTRY";
const TEST_ID_SEPARATOR = "::";
const BUN_TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;

type QuarantineRecord =
  | { readonly type: "loaded"; readonly file: string }
  | { readonly type: "registered"; readonly id: string }
  | {
      readonly type: "passed";
      readonly id: string;
      readonly durationMs: number;
    }
  | {
      readonly type: "failed";
      readonly id: string;
      readonly durationMs: number;
      readonly message: string;
    };

const splitTestId = (
  id: string,
): { file: string; name: string } | undefined => {
  const index = id.indexOf(TEST_ID_SEPARATOR);
  if (index === -1) {
    return undefined;
  }
  const file = id.slice(0, index);
  const name = id.slice(index + TEST_ID_SEPARATOR.length);
  if (
    !BUN_TEST_FILE.test(file) ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file.startsWith("../") ||
    name.trim() !== name ||
    name === ""
  ) {
    return undefined;
  }
  return { file, name };
};

const testId = ({ file, name }: { file: string; name: string }): string =>
  `${file}${TEST_ID_SEPARATOR}${name}`;

const readQuarantinedIds = (file: string): readonly string[] => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    console.warn(
      `Flaky-test quarantine disabled: invalid ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    console.warn(
      `Flaky-test quarantine disabled: invalid ${file}: registry must contain an entries array`,
    );
    return [];
  }
  const ids = value.entries.map((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    typeof entry.id === "string" &&
    splitTestId(entry.id) !== undefined
      ? entry.id
      : undefined,
  );
  if (ids.some((id) => id === undefined)) {
    console.warn(
      `Flaky-test quarantine disabled: invalid ${file}: every registry entry must contain a valid id`,
    );
    return [];
  }
  return ids.flatMap((id) => (id === undefined ? [] : [id]));
};

// Without a declared timeout a quarantined test gets this budget, then the
// runner's own deadline a grace period later, so a hang is recorded rather
// than failing the run.
const DEFAULT_BUDGET_MS = 60_000;
const RUNNER_GRACE_MS = 5000;
const MAX_MESSAGE = 300;

type TestFunction = (...args: unknown[]) => unknown;
type Outcome = { status: "passed" } | { status: "failed"; message: string };

const isFunction = (value: unknown): value is TestFunction =>
  typeof value === "function";

const errorMessage = (error: unknown): string => {
  const text = stripVTControlCharacters(
    error instanceof Error ? error.message : String(error),
  ).trim();
  const line = text.split("\n").find((value) => value.trim() !== "") ?? text;
  return line.length > MAX_MESSAGE
    ? `${line.slice(0, MAX_MESSAGE - 3)}...`
    : line;
};

// A `done`-style body resolves through its callback, as Bun's runner would.
const invoke = async (fn: TestFunction): Promise<unknown> => {
  if (fn.length === 0) {
    return await fn();
  }
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  fn((error?: unknown) => {
    if (error === undefined || error === null) {
      resolve(undefined);
    } else {
      reject(error instanceof Error ? error : inspect(error));
    }
  });
  return await promise;
};

const timeoutOf = (options: unknown): number | undefined => {
  if (typeof options === "number") {
    return options;
  }
  if (
    typeof options === "object" &&
    options !== null &&
    "timeout" in options &&
    typeof options.timeout === "number"
  ) {
    return options.timeout;
  }
  return undefined;
};

const objectValue = (row: unknown, key: string): unknown => {
  let value = row;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null || !(part in value)) {
      return undefined;
    }
    value = Reflect.get(value, part);
  }
  return value;
};

const formatTitleValue = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? inspect(value, { breakLength: Infinity, compact: true })
    : String(value);

const formatEachTitle = (
  title: string,
  values: readonly unknown[],
  index: number,
): string => {
  const row = values.length === 1 ? values.at(0) : undefined;
  const withVariables = title.replace(/\$([\w.]+)/gu, (match, key: string) => {
    const value = objectValue(row, key);
    return value === undefined ? match : formatTitleValue(value);
  });
  let valueIndex = 0;
  return withVariables.replace(/%%|%[sdifjo#]/gu, (placeholder): string => {
    if (placeholder === "%%") {
      return "%";
    }
    if (placeholder === "%#") {
      return String(index);
    }
    const value = values.at(valueIndex++);
    switch (placeholder) {
      case "%s":
        return String(value);
      case "%d":
        return String(Number(value));
      case "%i":
        return String(Number.parseInt(String(value), 10));
      case "%f":
        return String(Number.parseFloat(String(value)));
      case "%j":
        return JSON.stringify(value);
      case "%o":
        return inspect(value, { breakLength: Infinity, compact: true });
      default:
        return assert.fail(`Unhandled each title placeholder: ${placeholder}`);
    }
  });
};

const forward = (original: TestFunction, receiver: unknown): TestFunction =>
  new Proxy(original, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      return isFunction(value) ? forward(value, target) : value;
    },
    apply: (target, _self, args: unknown[]) => {
      const result = Reflect.apply(target, receiver, args);
      return isFunction(result) ? forward(result, target) : result;
    },
  });

const install = (reportDir: string): void => {
  const registryPath =
    process.env[QUARANTINE_REGISTRY_ENV] ??
    path.join(import.meta.dir, "flaky-test-quarantine.json");
  // The registry sits in <root>/scripts/, and ids are relative to <root>.
  // Bun.main is a real path, so the root is too (a symlinked checkout or
  // temporary directory would otherwise match no test file).
  const root = realpathSync(path.resolve(path.dirname(registryPath), ".."));
  const quarantined = new Set(readQuarantinedIds(registryPath));
  if (quarantined.size === 0) {
    return;
  }
  const files = new Set(
    [...quarantined].flatMap((id) => splitTestId(id)?.file ?? []),
  );
  mkdirSync(reportDir, { recursive: true });
  const out = path.join(reportDir, `${process.pid}-${randomUUID()}.jsonl`);
  const record = (value: QuarantineRecord): void => {
    appendFileSync(out, `${JSON.stringify(value)}\n`);
  };
  const loaded = new Set<string>();
  const currentFile = (): string | undefined => {
    // Registered ids are files under the root; anything else is not quarantined.
    const prefix = `${root}${path.sep}`;
    if (!Bun.main.startsWith(prefix)) {
      return undefined;
    }
    const relative = Bun.main.slice(prefix.length).replaceAll(path.sep, "/");
    if (!files.has(relative)) {
      return undefined;
    }
    if (!loaded.has(relative)) {
      loaded.add(relative);
      record({ type: "loaded", file: relative });
    }
    return relative;
  };

  // Bun defers nested describe bodies, so each body restores the path it was
  // declared under instead of relying on call nesting.
  let describePath: readonly string[] = [];
  const wrapDescribe = (
    original: TestFunction,
    receiver: unknown,
  ): TestFunction =>
    new Proxy(original, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (key === "each" && isFunction(value)) {
          return (...eachArgs: unknown[]) => {
            const registerRows = Reflect.apply(value, target, eachArgs);
            if (!isFunction(registerRows)) {
              return registerRows;
            }
            return (...args: unknown[]) => {
              const [label, body, ...rest] = args;
              if (typeof label !== "string" || !isFunction(body)) {
                return Reflect.apply(registerRows, value, args);
              }
              const parentScope = describePath;
              let rowIndex = 0;
              return Reflect.apply(registerRows, value, [
                label,
                (...bodyArgs: unknown[]) => {
                  const scope = [
                    ...parentScope,
                    formatEachTitle(label, bodyArgs, rowIndex++),
                  ];
                  const outer = describePath;
                  describePath = scope;
                  try {
                    return body(...bodyArgs);
                  } finally {
                    describePath = outer;
                  }
                },
                ...rest,
              ]);
            };
          };
        }
        return isFunction(value) ? wrapDescribe(value, target) : value;
      },
      apply: (target, _self, args: unknown[]) => {
        const [label, body, ...rest] = args;
        if (!isFunction(body)) {
          const result = Reflect.apply(target, receiver, args);
          return isFunction(result) ? wrapDescribe(result, target) : result;
        }
        const scope = [
          ...describePath,
          isFunction(label) ? label.name : String(label),
        ];
        return Reflect.apply(target, receiver, [
          label,
          (...bodyArgs: unknown[]) => {
            const outer = describePath;
            describePath = scope;
            try {
              return body(...bodyArgs);
            } finally {
              describePath = outer;
            }
          },
          ...rest,
        ]);
      },
    });
  const describe = wrapDescribe(bunTest.describe, bunTest.describe);

  const quarantine =
    (id: string, fn: TestFunction, budget: number) =>
    async (): Promise<void> => {
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race<Outcome>([
        invoke(fn).then(
          () => ({ status: "passed" }),
          (error: unknown) => ({
            status: "failed",
            message: errorMessage(error),
          }),
        ),
        new Promise<Outcome>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: "failed",
                message: `timed out after ${budget}ms`,
              }),
            budget,
          );
        }),
      ]);
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      if (outcome.status === "passed") {
        record({ type: "passed", id, durationMs });
        return;
      }
      // Narrowed to "failed": a new status without a message stops compiling here.
      record({ type: "failed", id, durationMs, message: outcome.message });
      console.error(`(quarantined fail) ${id}: ${outcome.message}`);
    };

  const register = (original: TestFunction, receiver: unknown): TestFunction =>
    new Proxy(original, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        return isFunction(value) ? forward(value, target) : value;
      },
      apply: (target, _self, args: unknown[]) => {
        const [label, second, third, ...rest] = args;
        const file = typeof label === "string" ? currentFile() : undefined;
        const id =
          file === undefined || typeof label !== "string"
            ? undefined
            : testId({ file, name: [...describePath, label].join(" > ") });
        if (id === undefined || !quarantined.has(id)) {
          return Reflect.apply(target, receiver, args);
        }
        const [fn, options] = isFunction(second)
          ? [second, third]
          : [third, second];
        if (!isFunction(fn) || rest.length > 0) {
          return Reflect.apply(target, receiver, args);
        }
        record({ type: "registered", id });
        const budget = timeoutOf(options) ?? DEFAULT_BUDGET_MS;
        return Reflect.apply(target, receiver, [
          label,
          quarantine(id, fn, budget),
          {
            ...(typeof options === "object" && options !== null ? options : {}),
            timeout: budget + RUNNER_GRACE_MS,
          },
        ]);
      },
    });

  const WRAPPED_FORMS = new Set<PropertyKey>(["only", "concurrent", "serial"]);
  const test = new Proxy(bunTest.test, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      if (!isFunction(value)) {
        return value;
      }
      return WRAPPED_FORMS.has(key)
        ? register(value, target)
        : forward(value, target);
    },
    apply: (target, _self, args: unknown[]) =>
      register(target, target)(...args),
  });

  void mock.module("bun:test", () => ({
    ...bunTest,
    describe,
    test,
    it: test,
  }));
};

const reportDir = process.env[QUARANTINE_REPORT_DIR_ENV];
// BUN_OPTIONS preloads run before Bun assigns the selected test file to
// `Bun.main`. Registration still checks `Bun.main`, after the runner has set it.
if (reportDir !== undefined && reportDir !== "") {
  install(reportDir);
}

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

import { panic } from "better-result";
import * as bunTest from "bun:test";
import { mock } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { inspect, stripVTControlCharacters } from "node:util";

import { repoRelativePath } from "@stll/portable-path";

import {
  QUARANTINE_REGISTRY_ENV,
  QUARANTINE_REPORT_DIR_ENV,
  readRegistry,
  REGISTRY_FILE,
  REPOSITORY_ROOT,
  splitTestId,
  testId,
  type QuarantineRecord,
} from "./flaky-test-quarantine";

// Without a declared timeout a quarantined test gets this budget, then the
// runner's own deadline a grace period later, so a hang is recorded rather
// than failing the run.
const DEFAULT_BUDGET_MS = 60_000;
const RUNNER_GRACE_MS = 5000;
const MAX_MESSAGE = 300;
const TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/u;

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
      reject(error instanceof Error ? error : new Error(inspect(error)));
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

const install = (reportDir: string): void => {
  const registryPath =
    process.env[QUARANTINE_REGISTRY_ENV] ??
    path.join(REPOSITORY_ROOT, REGISTRY_FILE);
  // The registry sits in <root>/scripts/, and ids are relative to <root>.
  const root = path.resolve(path.dirname(registryPath), "..");
  const quarantined = new Set(
    readRegistry(registryPath).entries.map(({ id }) => id),
  );
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
    const relative = repoRelativePath(root, Bun.main);
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
  const describe = new Proxy(bunTest.describe, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      return isFunction(value) ? value.bind(target) : value;
    },
    apply: (target, self, args: unknown[]) => {
      const [label, body, ...rest] = args;
      if (!isFunction(body)) {
        return Reflect.apply(target, self, args);
      }
      const scope = [
        ...describePath,
        isFunction(label) ? label.name : String(label),
      ];
      return Reflect.apply(target, self, [
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
      switch (outcome.status) {
        case "passed":
          record({ type: "passed", id, durationMs });
          return;
        case "failed":
          record({ type: "failed", id, durationMs, message: outcome.message });
          console.error(`(quarantined fail) ${id}: ${outcome.message}`);
          return;
        default:
          outcome satisfies never;
          panic("Unhandled quarantined outcome");
      }
    };

  const register =
    (original: TestFunction): TestFunction =>
    (...args: unknown[]) => {
      const [label, second, third, ...rest] = args;
      const file = typeof label === "string" ? currentFile() : undefined;
      const id =
        file === undefined || typeof label !== "string"
          ? undefined
          : testId({ file, name: [...describePath, label].join(" > ") });
      if (id === undefined || !quarantined.has(id)) {
        return original(...args);
      }
      const [fn, options] = isFunction(second)
        ? [second, third]
        : [third, second];
      if (!isFunction(fn) || rest.length > 0) {
        return original(...args);
      }
      record({ type: "registered", id });
      const budget = timeoutOf(options) ?? DEFAULT_BUDGET_MS;
      return original(label, quarantine(id, fn, budget), {
        ...(typeof options === "object" && options !== null ? options : {}),
        timeout: budget + RUNNER_GRACE_MS,
      });
    };

  const WRAPPED_FORMS = new Set<PropertyKey>(["only", "concurrent", "serial"]);
  const test = new Proxy(bunTest.test, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key, target);
      if (!isFunction(value)) {
        return value;
      }
      const bound = value.bind(target);
      return WRAPPED_FORMS.has(key) ? register(bound) : bound;
    },
    apply: (target, _self, args: unknown[]) =>
      register((...forwarded: unknown[]) =>
        Reflect.apply(target, undefined, forwarded),
      )(...args),
  });

  void mock.module("bun:test", () => ({
    ...bunTest,
    describe,
    test,
    it: test,
  }));
};

const reportDir = process.env[QUARANTINE_REPORT_DIR_ENV];
if (reportDir !== undefined && reportDir !== "" && TEST_FILE.test(Bun.main)) {
  install(reportDir);
}

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const API_ROOT = path.resolve(import.meta.dir, "..");
const API_CONFIG = path.join(API_ROOT, "tsconfig.json");
const PATHS_CONFIG = "./tsconfig.paths.json";
const VISUAL_SANDBOX_CONFIG = path.join(
  API_ROOT,
  "tsconfig.visual-sandbox.json",
);
const API_ALIAS_PROBE = "@/api/lib/constant-map";

const readConfig = (filename: string) => {
  const config = ts.readConfigFile(filename, (file) =>
    readFileSync(file, "utf-8"),
  );
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  return config.config;
};

test("API projects inherit one path-alias configuration", () => {
  expect(readConfig(API_CONFIG).extends).toBe(PATHS_CONFIG);
  expect(readConfig(VISUAL_SANDBOX_CONFIG).extends).toBe(PATHS_CONFIG);
});

test("the visual sandbox resolves API aliases", () => {
  const filename = path.resolve(VISUAL_SANDBOX_CONFIG);
  const config = readConfig(filename);
  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(filename),
    undefined,
    filename,
  );
  const resolved = ts.resolveModuleName(
    API_ALIAS_PROBE,
    path.join(API_ROOT, "e2e/alias-resolution.ts"),
    parsed.options,
    ts.sys,
  ).resolvedModule;

  if (!resolved) {
    throw new Error(
      `e2e/alias-resolution.ts(1,1): error TS2307: Cannot find module '${API_ALIAS_PROBE}' or its corresponding type declarations.`,
    );
  }

  expect(resolved.resolvedFileName).toBe(
    path.join(API_ROOT, "src/lib/constant-map.ts"),
  );
});

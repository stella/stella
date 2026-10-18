import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const API_CONFIG = "tsconfig.json";
const PATHS_CONFIG = "./tsconfig.paths.json";
const VISUAL_SANDBOX_CONFIG = "tsconfig.visual-sandbox.json";
const API_ALIAS_PROBE = "@/api/lib/constant-map";

const readConfig = (filename: string) => {
  const config = ts.readConfigFile(filename, ts.sys.readFile);
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
    path.resolve("e2e/alias-resolution.ts"),
    parsed.options,
    ts.sys,
  ).resolvedModule;

  if (!resolved) {
    throw new Error(
      `e2e/alias-resolution.ts(1,1): error TS2307: Cannot find module '${API_ALIAS_PROBE}' or its corresponding type declarations.`,
    );
  }

  expect(resolved.resolvedFileName).toBe(
    path.resolve("src/lib/constant-map.ts"),
  );
});

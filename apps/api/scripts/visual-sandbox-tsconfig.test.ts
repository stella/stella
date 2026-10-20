import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const API_ROOT = path.resolve(import.meta.dir, "..");
const API_CONFIG = path.join(API_ROOT, "tsconfig.json");
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

const apiAliases = (filename: string): Record<string, string[]> => {
  const paths = readConfig(filename).compilerOptions?.paths;
  const aliases: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(paths ?? {})) {
    if (!alias.startsWith("@/api/")) {
      continue;
    }
    if (
      !Array.isArray(targets) ||
      !targets.every((target) => typeof target === "string")
    ) {
      throw new Error(`${filename}: ${alias} must map to an array of paths`);
    }
    aliases[alias] = targets;
  }
  return aliases;
};

test("the visual sandbox mirrors every API path alias", () => {
  expect(apiAliases(VISUAL_SANDBOX_CONFIG)).toEqual(apiAliases(API_CONFIG));
});

const resolveApiAlias = (filename: string) => {
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

  return resolved.resolvedFileName;
};

test("the visual sandbox resolves API aliases identically to the API", () => {
  expect(resolveApiAlias(VISUAL_SANDBOX_CONFIG)).toBe(
    resolveApiAlias(API_CONFIG),
  );
});

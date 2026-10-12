import { panic } from "better-result";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

export const apiTypecheckArtifact = (
  api: string,
  name: "roots" | "src" | "tests",
) => path.join(api, ".cache/typecheck-declarations", `${name}.json`);

export const usesGeneratedApiConfig = (project: string) => {
  const read = ts.readConfigFile(project, ts.sys.readFile);
  const config = v.parse(
    v.object({
      extends: v.optional(v.union([v.string(), v.array(v.string())])),
    }),
    read.config,
  );
  return (
    Array.isArray(config.extends) &&
    config.extends.some((value) =>
      value.startsWith("./.cache/typecheck-declarations/"),
    )
  );
};

export const readApiTypecheckConfig = (project: string) => {
  const filename = path.resolve(project);
  const read = ts.readConfigFile(filename, ts.sys.readFile);
  if (usesGeneratedApiConfig(filename)) {
    const config = v.parse(
      v.object({ extends: v.array(v.string()) }),
      read.config,
    );
    for (const reference of config.extends) {
      if (
        reference.startsWith("./.cache/typecheck-declarations/") &&
        !existsSync(path.resolve(path.dirname(filename), reference))
      ) {
        panic(
          `Missing prepared API typecheck config: ${reference}; run bun --filter @stll/api generate:typecheck-declarations`,
        );
      }
    }
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(filename),
    undefined,
    filename,
  );
  const diagnostics = withoutTsgoOnlyOptionDiagnostics(
    read.error ? [read.error, ...parsed.errors] : parsed.errors,
  );
  if (diagnostics.length > 0) {
    panic(
      ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => path.dirname(filename),
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  }
  return parsed;
};

export const writeApiTypecheckArtifact = (filename: string, value: unknown) => {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
};

if (import.meta.main) {
  const project = process.argv[2];
  if (!project) {
    panic("Expected API typecheck project; run prep before checking");
  }
  readApiTypecheckConfig(project);
}

export const apiDeclarationConsumers = (project: string) => {
  const config = path.resolve(project);
  const root = path.resolve(path.dirname(config), "../..");
  const consumers: ts.ParsedCommandLine[] = [];
  for (const pattern of [
    "tsconfig*.json",
    "apps/*/tsconfig*.json",
    "packages/*/tsconfig*.json",
  ]) {
    for (const filename of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      const consumer = path.join(root, filename);
      if (consumer === config) {
        continue;
      }
      const read = ts.readConfigFile(consumer, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(consumer),
        undefined,
        consumer,
      );
      if (
        parsed.projectReferences?.some(
          (reference) => ts.resolveProjectReferencePath(reference) === config,
        )
      ) {
        consumers.push(parsed);
      }
    }
  }
  return consumers;
};

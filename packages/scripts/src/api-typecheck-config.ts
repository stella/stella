import { panic } from "better-result";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  API,
  formatDiagnostics,
  type ParsedCommandLine,
} from "tsrs/unstable/async";
import * as v from "valibot";

export const apiTypecheckArtifact = (
  api: string,
  name: "roots" | "src" | "tests",
) => path.join(api, ".cache/typecheck-declarations", `${name}.json`);

export const usesGeneratedApiConfig = (project: string) => {
  const read = Bun.JSONC.parse(readFileSync(project, "utf-8"));
  const config = v.parse(
    v.object({
      extends: v.optional(v.union([v.string(), v.array(v.string())])),
    }),
    read,
  );
  return (
    Array.isArray(config.extends) &&
    config.extends.some((value) =>
      value.startsWith("./.cache/typecheck-declarations/"),
    )
  );
};

export const readApiTypecheckConfig = async (project: string) => {
  const filename = path.resolve(project);
  const read = Bun.JSONC.parse(readFileSync(filename, "utf-8"));
  if (usesGeneratedApiConfig(filename)) {
    const config = v.parse(v.object({ extends: v.array(v.string()) }), read);
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
  const api = new API({ cwd: path.dirname(filename) });
  try {
    const parsed = await api.parseConfigFile(filename);
    if (parsed.errors.length > 0) {
      panic(formatDiagnostics(parsed.errors, api));
    }
    return parsed;
  } finally {
    await api.close();
  }
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
  await readApiTypecheckConfig(project);
}

export const apiDeclarationConsumers = async (project: string) => {
  const config = path.resolve(project);
  const root = path.resolve(path.dirname(config), "../..");
  const consumers: ParsedCommandLine[] = [];
  const api = new API({ cwd: root });
  try {
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
        const parsed = await api.parseConfigFile(consumer);
        if (
          parsed.projectReferences?.some(
            (reference) =>
              (reference.path.endsWith(".json")
                ? reference.path
                : path.join(reference.path, "tsconfig.json")) === config,
          )
        ) {
          consumers.push(parsed);
        }
      }
    }
    return consumers;
  } finally {
    await api.close();
  }
};

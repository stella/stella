import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import type { CompilerInputStamp } from "./compiler-input-stamp";

const ROOT_PREFIX = "$TURBO_ROOT$/";

const expandBraces = (pattern: string): string[] => {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (match === null) {
    return [pattern];
  }
  const [expression, alternatives = ""] = match;
  const start = match.index;
  return alternatives
    .split(",")
    .flatMap((alternative) =>
      expandBraces(
        `${pattern.slice(0, start)}${alternative}${pattern.slice(start + expression.length)}`,
      ),
    );
};

const matches = (file: string, pattern: string) => {
  if (pattern.endsWith("/**")) {
    return file.startsWith(pattern.slice(0, -2));
  }
  return file === pattern;
};

export const uncoveredCompilerInputs = (
  stamp: CompilerInputStamp,
  repoRoot: string,
  turboInputs: readonly string[],
) => {
  const included = turboInputs
    .filter((input) => input.startsWith(ROOT_PREFIX) && !input.startsWith("!"))
    .flatMap((input) => expandBraces(input.slice(ROOT_PREFIX.length)));
  const excluded = turboInputs
    .filter((input) => input.startsWith(`!${ROOT_PREFIX}`))
    .flatMap((input) => expandBraces(input.slice(ROOT_PREFIX.length + 1)));
  const candidates = new Set([
    ...Object.entries(stamp.contents)
      .filter(([, hash]) => hash !== null)
      .map(([file]) => file),
    ...stamp.files.present,
  ]);
  return [...candidates]
    .map((file) => repoRelativePath(repoRoot, file))
    .filter(
      (file) =>
        file !== ".." &&
        !file.startsWith("../") &&
        !file.startsWith("node_modules/") &&
        !file.includes("/node_modules/") &&
        !included.some((pattern) => matches(file, pattern)),
    )
    .filter((file) => !excluded.some((pattern) => matches(file, pattern)))
    .toSorted();
};

const turboConfigSchema = v.object({
  tasks: v.object({
    "@stll/web#generate:api-types": v.object({ inputs: v.array(v.string()) }),
  }),
});

export const webApiTurboInputs = (repoRoot: string): string[] => {
  const config = v.safeParse(
    turboConfigSchema,
    Bun.JSONC.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf-8")),
  );
  if (!config.success) {
    return panic(
      "generate-web-api-types: turbo.json has no string inputs for @stll/web#generate:api-types",
    );
  }
  return config.output.tasks["@stll/web#generate:api-types"].inputs;
};

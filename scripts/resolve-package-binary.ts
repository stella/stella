import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((entry) => typeof entry === "string");

export const resolvePackageBinary = (
  importMetaUrl: string,
  packageName: string,
) => {
  const require = createRequire(importMetaUrl);
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson: unknown = JSON.parse(
    readFileSync(packageJsonPath, "utf-8"),
  );

  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("bin" in packageJson) ||
    !isStringRecord(packageJson.bin) ||
    !(packageName in packageJson.bin) ||
    packageJson.bin[packageName] === undefined
  ) {
    panic(`${packageName} does not declare a ${packageName} binary`);
  }

  return path.resolve(
    path.dirname(packageJsonPath),
    packageJson.bin[packageName],
  );
};

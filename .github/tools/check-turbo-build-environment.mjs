import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const BUILD_SCRIPT_DIRECTORY = "packages/anonymize/scripts";
const BUILD_SCRIPT_PATTERN = /^build-.*\.mjs$/u;
const NAMED_ENVIRONMENT_ACCESS_PATTERN =
  /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/gu;

const turbo = JSON.parse(readFileSync("turbo.json", "utf8"));
const declaredEnvironment = new Set(turbo.tasks?.build?.env ?? []);
const usedEnvironment = new Map();
let failed = false;

for (const file of readdirSync(BUILD_SCRIPT_DIRECTORY).filter((entry) =>
  BUILD_SCRIPT_PATTERN.test(entry),
)) {
  const path = join(BUILD_SCRIPT_DIRECTORY, file);
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(NAMED_ENVIRONMENT_ACCESS_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name === undefined) {
      continue;
    }
    const paths = usedEnvironment.get(name) ?? new Set();
    paths.add(path);
    usedEnvironment.set(name, paths);
  }
  if (
    source
      .replaceAll(NAMED_ENVIRONMENT_ACCESS_PATTERN, "")
      .includes("process.env")
  ) {
    console.error(
      `${path} must use a direct named process.env access so Turbo can validate it`,
    );
    failed = true;
  }
}

for (const [name, paths] of [...usedEnvironment].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  if (declaredEnvironment.has(name)) {
    continue;
  }
  console.error(
    `${name} is read by ${[...paths].join(", ")} but is missing from turbo.json tasks.build.env`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

import { readFileSync } from "node:fs";
import path from "node:path";

import { rootObjectStart, stringTokenAt } from "./json-text-edit";

const DURATION_PATH = "apps/api/scripts/test-durations.json";
const API_PREFIX = "apps/api/";

// This guard also runs before dependencies are installed.
class AutofixTestDurationsError extends Error {
  readonly _tag = "AutofixTestDurationsError";

  constructor(message: string) {
    super(message);
    this.name = "AutofixTestDurationsError";
  }
}

const skipWhitespace = (text: string, start: number) => {
  let index = start;
  while (/\s/u.test(text[index] ?? "") && index < text.length) {
    index += 1;
  }
  return index;
};

/** Preserve value tokens, including numeric precision and internal formatting. */
const durationValueSources = (text: string) => {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AutofixTestDurationsError("API test durations must be an object");
  }
  const objectStart = rootObjectStart(text, DURATION_PATH);
  const entries = new Map<string, string>();
  let index = skipWhitespace(text, objectStart + 1);
  while (text[index] !== "}") {
    const key = stringTokenAt(text, index);
    if (entries.has(key.value)) {
      throw new AutofixTestDurationsError(
        `Duplicate API duration key: ${key.value}`,
      );
    }
    // JSON.parse validated the colon; scanning once avoids repeated root lookups.
    const colon = skipWhitespace(text, key.end);
    const start = skipWhitespace(text, colon + 1);
    if (text[start] !== "{") {
      throw new AutofixTestDurationsError(
        `API duration value must be an object: ${key.value}`,
      );
    }
    let depth = 1;
    index = start + 1;
    while (depth > 0 && index < text.length) {
      if (text[index] === '"') {
        index = stringTokenAt(text, index).end;
        continue;
      }
      if (text[index] === "{") {
        depth += 1;
      } else if (text[index] === "}") {
        depth -= 1;
      }
      index += 1;
    }
    entries.set(key.value, text.slice(start, index));
    index = skipWhitespace(text, index);
    if (text[index] === ",") {
      index = skipWhitespace(text, index + 1);
    }
  }
  return entries;
};

type ValidateAutofixTestDurationsOptions = {
  original: string;
  updated: string;
  addedFiles: readonly string[];
};

export const validateAutofixTestDurations = ({
  original,
  updated,
  addedFiles,
}: ValidateAutofixTestDurationsOptions): void => {
  const before = durationValueSources(original);
  const after = durationValueSources(updated);
  const allowed = new Set(
    addedFiles
      .filter(
        (file) => file.startsWith(API_PREFIX) && /\.test\.tsx?$/u.test(file),
      )
      .map((file) => file.slice(API_PREFIX.length)),
  );
  for (const [key, source] of before) {
    if (!after.has(key)) {
      throw new AutofixTestDurationsError(
        `Autofix removed API duration: ${key}`,
      );
    }
    if (after.get(key) !== source) {
      throw new AutofixTestDurationsError(
        `Autofix changed existing API duration: ${key}`,
      );
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key) && !allowed.has(key)) {
      throw new AutofixTestDurationsError(
        `Autofix added duration for a file not added by this PR: ${key}`,
      );
    }
  }
};

const gitOutput = (args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AutofixTestDurationsError(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

if (import.meta.main) {
  const [baseFlag, base, headFlag, head, ...extra] = process.argv.slice(2);
  if (
    baseFlag !== "--base" ||
    headFlag !== "--head" ||
    extra.length !== 0 ||
    base === undefined ||
    head === undefined ||
    !/^[a-f0-9]{40,64}$/u.test(base) ||
    !/^[a-f0-9]{40,64}$/u.test(head)
  ) {
    throw new AutofixTestDurationsError(
      "Usage: bun scripts/check-autofix-test-durations.ts --base <sha> --head <sha>",
    );
  }
  validateAutofixTestDurations({
    original: gitOutput(["show", `${head}:${DURATION_PATH}`]),
    updated: readFileSync(path.resolve(DURATION_PATH), "utf-8"),
    addedFiles: gitOutput([
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      "-z",
      `${base}...${head}`,
      "--",
      "apps/api",
    ])
      .split("\0")
      .filter(Boolean),
  });
  console.log(
    "Autofix API test durations retain existing entries and only add PR test files.",
  );
}

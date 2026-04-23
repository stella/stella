import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const HANDLERS_DIR = join(import.meta.dir, "../../handlers");
const FILE_SCHEMA_START = "t.File(";

const listTypeScriptFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(path)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
};

describe("file upload limits", () => {
  test("handler file schemas declare an explicit maxSize", async () => {
    const files = await listTypeScriptFiles(HANDLERS_DIR);
    const offenders: string[] = [];

    for (const file of files) {
      if (file.endsWith(".test.ts")) {
        continue;
      }

      const source = await readFile(file, "utf-8");
      for (const args of extractFileSchemaArgs(source)) {
        if (!args.includes("maxSize")) {
          offenders.push(file);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("extracts t.File args when options contain nested calls", () => {
    expect(
      extractFileSchemaArgs("const schema = t.File({ maxSize: getLimit() });"),
    ).toEqual(["{ maxSize: getLimit() }"]);
  });
});

const extractFileSchemaArgs = (source: string): string[] => {
  const args: string[] = [];
  let searchIndex = 0;

  while (true) {
    const startIndex = source.indexOf(FILE_SCHEMA_START, searchIndex);
    if (startIndex === -1) {
      return args;
    }

    const argsStartIndex = startIndex + FILE_SCHEMA_START.length;
    const argsEndIndex = findClosingParen(source, argsStartIndex);
    if (argsEndIndex === -1) {
      args.push("");
      return args;
    }

    args.push(source.slice(argsStartIndex, argsEndIndex));
    searchIndex = argsEndIndex + 1;
  }
};

const findClosingParen = (source: string, startIndex: number) => {
  let depth = 1;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source.at(index);
    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char !== ")") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return -1;
};

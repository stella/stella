import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const WEB_SOURCE_ROOT = path.resolve(import.meta.dir, "../apps/web/src");

/** Raw transport is reserved for responses the typed JSON client cannot consume. */
const RAW_JSON_STREAM_ALLOWLIST = {
  "components/ai-suggestions/document-review-proposal-stream.ts":
    "Consumes incremental document-review proposal output.",
  "components/autocomplete/use-autocomplete-stream.ts":
    "Consumes incremental autocomplete output.",
  "features/case-law/components/case-viewer/reader-answers-query.ts":
    "Consumes the streamed reader-answer response.",
  "routes/dev/-components/autocomplete-playground.tsx":
    "Exercises the same incremental autocomplete stream in development.",
} as const satisfies Record<string, string>;

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;
const TEST_MODULE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const RAW_JSON_API_CALL =
  /(?:fetch|fetchWithTimeout)\(\s*apiUrl\([\s\S]{0,600}?\{[\s\S]{0,600}?body\s*:\s*JSON\.stringify\s*\(/gu;

const walk = async (directory: string): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walk(entryPath)));
    } else if (
      SOURCE_EXTENSION.test(entry.name) &&
      !TEST_MODULE.test(entryPath)
    ) {
      paths.push(entryPath);
    }
  }
  return paths;
};

export const findRawJsonApiCalls = async (
  paths: readonly string[],
  sourceRoot = WEB_SOURCE_ROOT,
) => {
  const violations: string[] = [];
  for (const filePath of paths) {
    const source = await readFile(filePath, "utf-8");
    if (!RAW_JSON_API_CALL.test(source)) {
      RAW_JSON_API_CALL.lastIndex = 0;
      continue;
    }
    RAW_JSON_API_CALL.lastIndex = 0;
    const modulePath = repoRelativePath(sourceRoot, filePath);
    if (!(modulePath in RAW_JSON_STREAM_ALLOWLIST)) {
      violations.push(modulePath);
    }
  }
  return violations;
};

if (import.meta.main) {
  const violations = await findRawJsonApiCalls(await walk(WEB_SOURCE_ROOT));
  if (violations.length > 0) {
    console.error(
      `JSON API requests must use the typed client:\n${violations.map((filePath) => `- ${filePath}`).join("\n")}`,
    );
    process.exitCode = 1;
  }
}

import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

/**
 * What a native step produced that the member may open on this computer: a
 * command's output, or the diff of each file a change wrote. It stays here:
 * the sidecar keeps it in the store `run.start` names
 * (`sidecar/step-outputs.ts`) and the desktop serves it to a page on this
 * computer. It is never part of what a turn reports.
 */
export type HarnessStepOutput =
  | { type: "command"; output: string }
  | { type: "diff"; files: readonly HarnessFileDiff[] };

export type HarnessFileDiff = { path: string; diff: string };

const LINE_BREAK = /\r\n|\n/u;

const prefixed = (text: string, mark: "+" | "-") =>
  text === ""
    ? ""
    : text
        .replace(/\r?\n$/u, "")
        .split(LINE_BREAK)
        .map((line) => `${mark}${line}`)
        .join("\n");

/** A file's whole text as added (`+`) or removed (`-`) lines. */
export const wholeFileDiff = (text: string, change: "add" | "delete") =>
  prefixed(text, change === "add" ? "+" : "-");

/** One replacement in a file: what it removed, then what it put in its place. */
export const replacementDiff = (removed: string, added: string) =>
  ["@@", prefixed(removed, "-"), prefixed(added, "+")]
    .filter((part) => part !== "")
    .join("\n");

/**
 * `file` relative to the run's folder, with `/` between its parts, when it is
 * inside the folder; else as given.
 */
export const runRelativePath = (file: string, workspaceDir: string) => {
  if (!path.isAbsolute(file) || !isPathInside(workspaceDir, file)) {
    return file;
  }
  const relative = repoRelativePath(workspaceDir, file);
  return relative === "" ? "." : relative;
};

/**
 * The text a step's output is kept as: a command's output as it came, and a
 * change as one diff, each file under a `---`/`+++` header naming it
 * relative to the run's folder.
 */
export const stepOutputText = (
  output: HarnessStepOutput,
  workspaceDir: string,
): string => {
  if (output.type === "command") {
    return output.output;
  }
  return output.files
    .map(({ path: file, diff }) => {
      const shown = runRelativePath(file, workspaceDir);
      const body = diff.endsWith("\n") || diff === "" ? diff : `${diff}\n`;
      return `--- ${shown}\n+++ ${shown}\n${body}`;
    })
    .join("");
};

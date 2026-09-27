#!/usr/bin/env bun

import { panic } from "better-result";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { listSqlPerfAllowComments } from "./sql-perf-detector.ts";
import { isSqlPerfSource } from "./sql-perf-scope.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const base = process.env["BASE_SHA"];
if (!base) {
  panic("BASE_SHA must identify the pull request or merge-group base");
}

const diff = Bun.spawnSync(
  ["git", "diff", "--no-ext-diff", "--unified=0", `${base}...HEAD`, "--"],
  { cwd: ROOT, stderr: "inherit", stdout: "pipe" },
);
if (diff.exitCode !== 0) {
  panic(`Could not diff against BASE_SHA ${base}`);
}

type Suppression = { file: string; line: number; reason: string };
const addedLines = new Map<string, Set<number>>();
let file = "";
let currentLine = 0;
for (const line of diff.stdout.toString().split("\n")) {
  if (line.startsWith("+++ b/")) {
    file = line.slice("+++ b/".length);
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
  if (hunk) {
    currentLine = Number(hunk[1] ?? panic("Diff hunk has no new line number"));
    continue;
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    if (isSqlPerfSource(file)) {
      const lines = addedLines.get(file) ?? new Set<number>();
      lines.add(currentLine);
      addedLines.set(file, lines);
    }
    currentLine += 1;
    continue;
  }
  if (line.startsWith(" ")) {
    currentLine += 1;
  }
}
const additions: Suppression[] = [];
for (const [sourceFile, lines] of addedLines) {
  const source = readFileSync(path.join(ROOT, sourceFile), "utf-8");
  for (const comment of listSqlPerfAllowComments(source, sourceFile)) {
    if (lines.has(comment.line)) {
      additions.push({ file: sourceFile, ...comment });
    }
  }
}

const escapeMarkdown = (value: string): string =>
  value.replaceAll("`", "\\`").replaceAll("|", "\\|");
const summary = [
  "### SQL performance suppressions",
  "",
  `New suppressions: **${additions.length}**`,
  ...(additions.length === 0
    ? ["", "No new `sql-perf-allow` comments."]
    : [
        "",
        ...additions.map(
          ({ file: filePath, line: lineNumber, reason }) =>
            `- \`${escapeMarkdown(filePath)}:${lineNumber}\`: ${escapeMarkdown(reason) || "(missing reason)"}`,
        ),
      ]),
  "",
].join("\n");

console.log(summary.trimEnd());
const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
if (summaryPath) {
  appendFileSync(summaryPath, summary);
}

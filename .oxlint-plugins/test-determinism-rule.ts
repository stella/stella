import type { Context, ESTree } from "@oxlint/plugins";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseTestBaseline } from "../scripts/check-test-state-baseline.ts";
import { repoRelativeFilename } from "./utils.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const baselineCounts = (baselinePath: string) => {
  const counts = new Map<string, number>();
  for (const member of parseTestBaseline(
    readFileSync(path.join(REPO_ROOT, baselinePath), "utf-8"),
    baselinePath,
  )) {
    const file = member.slice(0, member.lastIndexOf("::"));
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
};

type CreateTestDeterminismRuleOptions = {
  baselinePath: string;
  message: string;
  createDetector: (context: Context) => (node: ESTree.Node) => boolean;
};

export const createTestDeterminismRule = ({
  baselinePath,
  message,
  createDetector,
}: CreateTestDeterminismRuleOptions) => ({
  meta: {
    type: "problem" as const,
    messages: {
      nondeterminism: message,
      escapedSlot: `Escaped occurrences still need a baseline slot. ${message}`,
      stale: `{{file}} now has {{count}} occurrences (baseline {{baseline}}). Shrink ${baselinePath} in this change.`,
    },
  },
  createOnce(context: Context) {
    const counts = baselineCounts(baselinePath);
    const detects = createDetector(context);
    let filename = "";
    let enabled = false;
    let hits: ESTree.Node[] = [];
    let escapedLines = new Set<number>();
    const visit = (node: ESTree.Node) => {
      if (enabled && detects(node)) {
        hits.push(node);
      }
    };
    return {
      Program() {
        filename = repoRelativeFilename(context);
        enabled =
          TEST_FILE.test(filename) &&
          !/(?:^|\/)packages\/test-kit\//u.test(filename);
        hits = [];
        escapedLines = new Set();
        for (const comment of context.sourceCode.getAllComments()) {
          if (
            comment.type !== "Line" ||
            !/^\s*kit-allow:\s*\S/u.test(comment.value)
          ) {
            continue;
          }
          escapedLines.add(comment.loc.start.line);
          escapedLines.add(comment.loc.start.line + 1);
        }
      },
      CallExpression: visit,
      NewExpression: visit,
      BinaryExpression: visit,
      "Program:exit"(node: ESTree.Program) {
        if (!enabled) {
          return;
        }
        if (context.settings.testDeterminismCensus === true) {
          for (const hit of hits) {
            context.report({ node: hit, messageId: "nondeterminism" });
          }
          return;
        }
        // Scratch-file tests supply budgets without mutating the committed census.
        const injected = context.settings.testDeterminismBaseline;
        let baseline = counts.get(filename) ?? 0;
        if (typeof injected === "object" && injected !== null) {
          for (const [file, count] of Object.entries(injected)) {
            if (
              (filename === file || filename.endsWith(`/${file}`)) &&
              typeof count === "number" &&
              Number.isSafeInteger(count) &&
              count >= 0
            ) {
              baseline = count;
            }
          }
        }
        if (hits.length < baseline) {
          context.report({
            node,
            messageId: "stale",
            data: { file: filename, count: hits.length, baseline },
          });
        }
        const excess = hits.length - baseline;
        if (excess <= 0) {
          return;
        }
        const unescaped = hits.filter(
          (hit) => !escapedLines.has(hit.loc.start.line),
        );
        const escaped = hits.filter((hit) =>
          escapedLines.has(hit.loc.start.line),
        );
        // Every occurrence needs a slot; explain unescaped excess before documented intent.
        const candidates = [...unescaped.toReversed(), ...escaped.toReversed()];
        for (const hit of candidates.slice(0, excess)) {
          context.report({
            node: hit,
            messageId: escapedLines.has(hit.loc.start.line)
              ? "escapedSlot"
              : "nondeterminism",
          });
        }
      },
    };
  },
});

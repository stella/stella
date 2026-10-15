import { Result } from "better-result";
import parse from "shell-quote/parse";

import { testRunnerFlagArity } from "../apps/api/scripts/test-path-filters";

type UnsupportedReason =
  | "invalid-shell-quoting"
  | "shell-expansion"
  | "shell-syntax"
  | "not-plain-bun-test"
  | "unknown-flag"
  | "missing-flag-value"
  | "runner-controlled-flag";
type ParsedTestScript =
  | { type: "supported"; flags: string[] }
  | { type: "unsupported"; reason: UnsupportedReason };

const BOOLEAN_FLAGS = new Set([
  "--coverage",
  "--only",
  "--todo",
  "--concurrent",
  "--serial",
  "--update-snapshots",
  "-u",
  "--isolate",
]);
const CONTROLLED_FLAGS = new Set([
  "--cwd",
  "--watch",
  "--hot",
  "--rerun-each",
  "--seed",
  "--randomize",
  "--shard",
]);

const shellSyntaxProblem = (script: string): UnsupportedReason | undefined => {
  if (/[\r\n]/u.test(script)) {
    return "shell-syntax";
  }
  let quote: "plain" | "single" | "double" = "plain";
  for (let index = 0; index < script.length; index += 1) {
    const character = script.at(index);
    if (quote !== "single" && character === "\\") {
      if (index + 1 === script.length) {
        return "invalid-shell-quoting";
      }
      index += 1;
      continue;
    }
    if (quote !== "single" && (character === "$" || character === "`")) {
      return "shell-expansion";
    }
    if (quote === "plain") {
      if (character === "'") {
        quote = "single";
      } else if (character === '"') {
        quote = "double";
      } else if (character === "{" || character === "}" || character === "~") {
        return "shell-expansion";
      }
      continue;
    }
    if (
      (quote === "single" && character === "'") ||
      (quote === "double" && character === '"')
    ) {
      quote = "plain";
    }
  }
  return quote === "plain" ? undefined : "invalid-shell-quoting";
};

/** Only a literal Bun test command can safely replace its positional selectors. */
export const parseBunTestScript = (script: string): ParsedTestScript => {
  const problem = shellSyntaxProblem(script);
  if (problem) {
    return { type: "unsupported", reason: problem };
  }
  const parsed = Result.try(() => parse(script));
  if (parsed.isErr()) {
    return { type: "unsupported", reason: "invalid-shell-quoting" };
  }
  const words: string[] = [];
  for (const token of parsed.value) {
    if (typeof token !== "string") {
      return { type: "unsupported", reason: "shell-syntax" };
    }
    words.push(token);
  }
  if (words.at(0) !== "bun" || words.at(1) !== "test") {
    return { type: "unsupported", reason: "not-plain-bun-test" };
  }
  return parseFlags(words.slice(2));
};

const parseFlags = (words: readonly string[]): ParsedTestScript => {
  const flags: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words.at(index);
    if (word === undefined || word === "--") {
      break;
    }
    if (!word.startsWith("-")) {
      continue;
    }
    const equals = word.indexOf("=");
    const flag = equals === -1 ? word : word.slice(0, equals);
    if (CONTROLLED_FLAGS.has(flag)) {
      return { type: "unsupported", reason: "runner-controlled-flag" };
    }
    const arity = testRunnerFlagArity(flag);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (equals !== -1) {
        return { type: "unsupported", reason: "unknown-flag" };
      }
      flags.push(word);
      continue;
    }
    if (arity === undefined) {
      return { type: "unsupported", reason: "unknown-flag" };
    }
    if (equals !== -1) {
      if (equals === word.length - 1) {
        return { type: "unsupported", reason: "missing-flag-value" };
      }
      if (
        arity === "optional-number" &&
        !/^\d+$/u.test(word.slice(equals + 1))
      ) {
        return { type: "unsupported", reason: "missing-flag-value" };
      }
      flags.push(word);
      continue;
    }
    flags.push(word);
    const next = words.at(index + 1);
    if (
      arity === "optional-number" &&
      (next === undefined || !/^\d+$/u.test(next))
    ) {
      continue;
    }
    if (!next || next.startsWith("-")) {
      return { type: "unsupported", reason: "missing-flag-value" };
    }
    flags.push(next);
    index += 1;
  }
  return { type: "supported", flags };
};

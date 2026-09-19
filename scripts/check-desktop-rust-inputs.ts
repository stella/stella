#!/usr/bin/env bun

// Guard: the desktop native test task's turbo.json inputs, the files Rust
// embeds from outside the crate, and the CI Rust change detector must all
// name the same paths.
//
// `apps/desktop/src-tauri` reads fixtures, translations, the clipboard type
// source, and generated API-contract files from outside the crate with
// `include_str!`/`include_bytes!`. Three lists have to stay in sync with
// those embeds: `@stll/desktop#test:native`.inputs in turbo.json (so Turbo
// caches a native pass only on the files it actually compiles),
// `scripts/detect-tauri-rust-changes.sh` (so CI runs the Rust job on a
// change to any of them), and this script, which reads the Rust source
// itself as the source of truth.
//
// An embed not covered by any input fails; so does an input no embed falls
// under any more (the list can only shrink to what the crate still reads),
// and so does a path the CI detector would not flag. A macro argument that
// is not a plain string literal cannot be verified, so it fails outright
// instead of being skipped.
//
//   bun scripts/check-desktop-rust-inputs.ts

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { matchesRootInput } from "./check-test-input-coverage.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TURBO_CONFIG = "turbo.json";
const TURBO_ROOT_INPUT_PREFIX = "$TURBO_ROOT$/";
const DESKTOP_DIR = "apps/desktop";
const CRATE_DIR = "apps/desktop/src-tauri";
const CRATE_SUBTREE_INPUT = "src-tauri/**";
const TASK_NAME = "@stll/desktop#test:native";
const DETECTOR_SCRIPT = "scripts/detect-tauri-rust-changes.sh";
const NEGATION_PREFIX = "!";
const LINE_COMMENT = "//";
const BLOCK_COMMENT_OPEN = "/*";
const BLOCK_COMMENT_CLOSE = "*/";
const INCLUDE_MACRO_NAMES = ["include_str!", "include_bytes!"] as const;
const MACRO_CALL_OPEN = "(";
const WHITESPACE = /\s/u;
const UNICODE_ESCAPE_MARKER = "u";
const UNICODE_ESCAPE_CLOSE = "}";

type IncludeMacroCall =
  | {
      readonly kind: "literal";
      readonly macro: string;
      readonly line: number;
      readonly literal: string;
    }
  | {
      readonly kind: "non-literal";
      readonly macro: string;
      readonly line: number;
    };

const countNewlines = (text: string): number => text.split("\n").length - 1;

/**
 * Every `include_str!`/`include_bytes!` call in a Rust source file. Comments
 * and unrelated string literals are skipped so a doc comment that mentions
 * the macro by name, or an unrelated string containing its text, is never
 * mistaken for a call. The macro's argument may sit on the line after the
 * opening paren, so whitespace between `(` and the literal is skipped too. A
 * call whose argument is not a plain string literal (`concat!`, `env!`, an
 * identifier) is reported rather than silently skipped: the guard cannot
 * verify what it cannot resolve.
 */
export const extractIncludeMacroCalls = (
  source: string,
): readonly IncludeMacroCall[] => {
  const calls: IncludeMacroCall[] = [];
  let index = 0;
  let line = 1;

  const readStringLiteral = (): string => {
    index += 1;
    let value = "";
    while (index < source.length) {
      const char = source.charAt(index);
      if (char === "\\") {
        value += source.charAt(index + 1);
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === "\n") {
        line += 1;
      }
      value += char;
      index += 1;
    }
    return panic(
      `check-desktop-rust-inputs: unterminated string literal starting at line ${line}`,
    );
  };

  const matchIncludeMacro = (position: number): string | undefined =>
    INCLUDE_MACRO_NAMES.find((name) =>
      source.startsWith(`${name}${MACRO_CALL_OPEN}`, position),
    );

  /**
   * A char literal (`'"'`, `'\''`, `'\u{1F600}'`) can hold a double quote,
   * which would otherwise desync the scanner's string-literal matching. A
   * lifetime (`'a`, `'static`) is not a char literal: it never closes with a
   * `'`, so the lookahead finds no match and the quote is left for the
   * default case to skip on its own.
   */
  const skipCharLiteral = (): boolean => {
    let cursor = index + 1;
    if (source.charAt(cursor) === "\\") {
      cursor =
        source.charAt(cursor + 1) === UNICODE_ESCAPE_MARKER
          ? (() => {
              const close = source.indexOf(UNICODE_ESCAPE_CLOSE, cursor);
              return close === -1 ? cursor + 2 : close + 1;
            })()
          : cursor + 2;
    } else {
      cursor += 1;
    }
    if (source.charAt(cursor) !== "'") {
      return false;
    }
    index = cursor + 1;
    return true;
  };

  while (index < source.length) {
    if (source.startsWith(LINE_COMMENT, index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith(BLOCK_COMMENT_OPEN, index)) {
      const end = source.indexOf(BLOCK_COMMENT_CLOSE, index + 2);
      const stop =
        end === -1 ? source.length : end + BLOCK_COMMENT_CLOSE.length;
      line += countNewlines(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source.charAt(index) === "'" && skipCharLiteral()) {
      continue;
    }
    if (source.charAt(index) === '"') {
      readStringLiteral();
      continue;
    }
    if (source.charAt(index) === "\n") {
      line += 1;
      index += 1;
      continue;
    }

    const macro = matchIncludeMacro(index);
    if (macro === undefined) {
      index += 1;
      continue;
    }

    const callLine = line;
    index += macro.length + MACRO_CALL_OPEN.length;
    while (index < source.length && WHITESPACE.test(source.charAt(index))) {
      if (source.charAt(index) === "\n") {
        line += 1;
      }
      index += 1;
    }
    if (source.charAt(index) === '"') {
      calls.push({
        kind: "literal",
        line: callLine,
        literal: readStringLiteral(),
        macro,
      });
    } else {
      calls.push({ kind: "non-literal", line: callLine, macro });
    }
  }

  return calls;
};

/**
 * The repository-relative path an embed resolves to, `include_str!` paths
 * being relative to the source file that contains them (Rust's own rule).
 */
export const resolveEmbedPath = (
  rustFileRepoPath: string,
  literal: string,
): string => {
  const directory = path.posix.dirname(rustFileRepoPath);
  const resolved = path.posix.normalize(path.posix.join(directory, literal));
  if (resolved === ".." || resolved.startsWith("../")) {
    panic(
      `check-desktop-rust-inputs: ${rustFileRepoPath} embeds "${literal}", which resolves outside the repository`,
    );
  }
  return resolved;
};

const isInsideCrate = (target: string): boolean =>
  target === CRATE_DIR || target.startsWith(`${CRATE_DIR}/`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readTaskInputs = (root: string): readonly string[] => {
  const parsed: unknown = Bun.JSONC.parse(
    readFileSync(path.join(root, TURBO_CONFIG), "utf-8"),
  );
  const tasks = isRecord(parsed) ? parsed["tasks"] : undefined;
  if (!isRecord(tasks)) {
    panic(`${TURBO_CONFIG} must declare tasks`);
  }
  const task = tasks[TASK_NAME];
  if (!isRecord(task)) {
    panic(`${TURBO_CONFIG} must declare tasks["${TASK_NAME}"]`);
  }
  const inputs = task["inputs"];
  if (!Array.isArray(inputs)) {
    panic(`${TURBO_CONFIG}: tasks["${TASK_NAME}"].inputs must be an array`);
  }
  return inputs.filter((entry): entry is string => typeof entry === "string");
};

type DeclaredInput = { readonly raw: string; readonly resolved: string };

/**
 * Declared inputs resolved to repository-relative targets so they compare
 * directly against an embed's resolved path. A package-relative entry
 * resolves against `apps/desktop`; a `$TURBO_ROOT$/` entry against the repo
 * root. Negations are dropped: they exclude paths from the cache key, not
 * from coverage.
 */
const declaredInputs = (root: string): readonly DeclaredInput[] =>
  readTaskInputs(root)
    .filter((entry) => !entry.startsWith(NEGATION_PREFIX))
    .map((entry) => ({
      raw: entry,
      resolved: entry.startsWith(TURBO_ROOT_INPUT_PREFIX)
        ? entry.slice(TURBO_ROOT_INPUT_PREFIX.length)
        : path.posix.join(DESKTOP_DIR, entry),
    }));

const rustSourceFiles = (root: string): readonly string[] =>
  [
    ...new Bun.Glob("**/*.rs").scanSync({
      cwd: path.join(root, CRATE_DIR),
      onlyFiles: true,
    }),
  ]
    .filter((relative) => !relative.split("/").includes("target"))
    .toSorted();

type Embed = { readonly file: string; readonly line: number };

export const checkDesktopRustInputs = (root: string): readonly string[] => {
  const errors: string[] = [];
  const embeds = new Map<string, Embed>();

  for (const relative of rustSourceFiles(root)) {
    const rustFileRepoPath = `${CRATE_DIR}/${relative}`;
    const source = readFileSync(path.join(root, rustFileRepoPath), "utf-8");

    for (const call of extractIncludeMacroCalls(source)) {
      if (call.kind === "non-literal") {
        errors.push(
          `${rustFileRepoPath}:${call.line} calls ${call.macro}(...) with an argument that is not a plain string literal.\n` +
            `    Fix: check-desktop-rust-inputs.ts can only verify a literal path; embed a plain string literal instead.`,
        );
        continue;
      }
      const target = resolveEmbedPath(rustFileRepoPath, call.literal);
      if (isInsideCrate(target) || embeds.has(target)) {
        continue;
      }
      embeds.set(target, { file: rustFileRepoPath, line: call.line });
    }
  }

  const inputs = declaredInputs(root);

  for (const [target, { file, line }] of embeds) {
    const covered = inputs.some((input) =>
      matchesRootInput(target, input.resolved),
    );
    if (!covered) {
      errors.push(
        `${file}:${line} embeds "${target}" from outside the crate, which no ${TASK_NAME} input covers.\n` +
          `    Fix: add "${target}" (or a "dir/**" subtree above it) to tasks["${TASK_NAME}"].inputs in ${TURBO_CONFIG}.`,
      );
    }
  }

  for (const input of inputs) {
    if (input.raw === CRATE_SUBTREE_INPUT) {
      continue;
    }
    const matched = [...embeds.keys()].some((target) =>
      matchesRootInput(target, input.resolved),
    );
    if (!matched) {
      errors.push(
        `${TURBO_CONFIG}: tasks["${TASK_NAME}"].inputs declares "${input.raw}", which no include_str!/include_bytes! embed falls under any more.\n` +
          `    Fix: delete the input, or narrow it to what the crate still embeds.`,
      );
    }
  }

  for (const target of embeds.keys()) {
    const result = Bun.spawnSync(["bash", DETECTOR_SCRIPT, target], {
      cwd: root,
      stderr: "inherit",
      stdout: "pipe",
    });
    const detected = result.stdout.toString().trim();
    if (detected !== "true") {
      errors.push(
        `${DETECTOR_SCRIPT} does not report "${target}" as a desktop Rust change (printed "${detected}").\n` +
          `    Fix: add a case pattern for this path to ${DETECTOR_SCRIPT}.`,
      );
    }
  }

  return errors;
};

const main = (): number => {
  const errors = checkDesktopRustInputs(REPO_ROOT);
  if (errors.length > 0) {
    console.error(
      "Desktop Rust embeds, turbo.json inputs, and the CI detector are out of sync:\n",
    );
    for (const error of errors) {
      console.error(`- ${error}\n`);
    }
    return 1;
  }
  console.log(
    "desktop Rust inputs: OK (every include_str!/include_bytes! embed is a declared, detected input).",
  );
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}

import { panic } from "better-result";
import { parseSync } from "oxc-parser";

import { sha256Hex } from "@stll/sha256/bun";

import { type Comment, walk } from "../packages/scripts/src/syntax-tree.ts";
import type { DatedWaiver } from "./dated-waivers";

/** A waiver's stable identity across runs: its kind, owner file and id. */
export const waiverKey = (entry: DatedWaiver): string =>
  sha256Hex(JSON.stringify([entry.kind, entry.source, entry.id])).slice(0, 24);

export const DAY_MS = 86_400_000;
export const TEST_ATTEMPTS = 20;

/**
 * The documented zero-age override as one complete argument: `=` or any
 * spaces or tabs, then a zero that ends the argument (so `0.5` is not one).
 * Inventory and removal share it, so every inventoried spelling is removable.
 */
export const ZERO_AGE_OVERRIDE =
  /[ \t]--minimum-release-age(?:=|[ \t]+)0(?=$|[\s"'`;&|)])/u;

export const DOC_SOURCE_FILE = ".claude/mcp/doc-sources.ts";
// Date-only owners accept through the entire UTC day. Preserve that boundary.
export const expiryInstant = (date: string): string => {
  const instant = date.length === 10 ? `${date}T00:00:00.000Z` : date;
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== instant) {
    panic(`Invalid dated waiver expiry: ${date}`);
  }
  return date.length === 10 ? new Date(ms + DAY_MS).toISOString() : instant;
};

// Runs one test through its owning package script, filtered by its title.
type TestProbeOptions = { file: string; title: string };
export const testProbeCommand = ({
  file,
  title,
}: TestProbeOptions): readonly string[] => {
  const owner = /^(?:apps|packages)\/[^/]+/u.exec(file)?.at(0);
  const pattern = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const relative = owner ? file.slice(owner.length + 1) : file;
  return owner
    ? ["bun", `--cwd=${owner}`, "run", "test", "--", relative, "-t", pattern]
    : ["bun", "test", file, "-t", pattern];
};

// Where the whitespace and comments before `offset` begin: the end of the
// previous token.
const leadingTriviaStart = (
  contents: string,
  comments: readonly Comment[],
  offset: number,
): number => {
  const commentStartByEnd = new Map(
    comments.map((comment) => [comment.end, comment.start]),
  );
  let start = offset;
  for (;;) {
    while (start > 0 && /\s/u.test(contents.charAt(start - 1))) {
      start -= 1;
    }
    const commentStart = commentStartByEnd.get(start);
    if (commentStart === undefined) {
      return start;
    }
    start = commentStart;
  }
};

// A dated test quarantine is an adjacent comment on a literal test.skip/it.skip
// call. The inventory guard blocks at expiry even while the source still skips.
const readFileQuarantines = (
  source: string,
  contents: string,
): DatedWaiver[] => {
  const entries: DatedWaiver[] = [];
  // Syntax errors are read as data: only a file with markers must parse.
  const parsed = parseSync(source, contents);
  const consumed = new Set<number>();
  const markers = new Map<number, string>();
  for (const comment of parsed.comments) {
    const match = /test-quarantine-expires:\s*(\S+)/u.exec(
      contents.slice(comment.start, comment.end),
    );
    if (match) {
      markers.set(comment.start, match.at(1) ?? "");
    }
  }
  if (markers.size === 0) {
    return entries;
  }
  if (
    parsed.errors.some((error) => {
      // oxc-parser declares Severity as an ambient const enum of strings.
      const severity: string = error.severity;
      return severity === "Error";
    })
  ) {
    panic(`Test quarantine owner does not parse: ${source}`);
  }
  walk(parsed.program, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      node.callee.computed ||
      node.callee.property.type !== "Identifier" ||
      node.callee.property.name !== "skip" ||
      !["test", "it"].includes(
        contents.slice(node.callee.object.start, node.callee.object.end),
      )
    ) {
      return;
    }
    const fullStart = leadingTriviaStart(contents, parsed.comments, node.start);
    const markersHere = [...markers].filter(
      ([offset]) => offset >= fullStart && offset < node.start,
    );
    if (markersHere.length === 0) {
      return;
    }
    const marker = markersHere.at(0);
    const title = node.arguments.at(0);
    if (
      markersHere.length !== 1 ||
      !marker ||
      title?.type !== "Literal" ||
      typeof title.value !== "string"
    ) {
      panic(
        `Test quarantine needs one literal test title and expiry: ${source}`,
      );
    }
    const [offset, expiresAt] = marker;
    expiryInstant(expiresAt);
    consumed.add(offset);
    entries.push({
      source,
      line: contents.slice(0, node.start).split("\n").length,
      id: title.value,
      kind: "quarantined-test",
      expiresAt,
      probe: {
        command: testProbeCommand({ file: source, title: title.value }),
        attempts: TEST_ATTEMPTS,
      },
    });
  });
  if (consumed.size !== markers.size) {
    panic(`Unowned dated test quarantine marker: ${source}`);
  }
  return entries;
};

export const readTestQuarantines = (
  sources: Readonly<Record<string, string>>,
): DatedWaiver[] =>
  Object.entries(sources).flatMap(([source, contents]) =>
    readFileQuarantines(source, contents),
  );

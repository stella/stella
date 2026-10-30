import { panic } from "better-result";
import ts from "typescript6";

import type { DatedWaiver } from "./dated-waivers";

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

// A dated test quarantine is an adjacent comment on a literal test.skip/it.skip
// call. The inventory guard blocks at expiry even while the source still skips.
export const readTestQuarantines = (
  sources: Readonly<Record<string, string>>,
): DatedWaiver[] => {
  const entries: DatedWaiver[] = [];
  for (const [source, contents] of Object.entries(sources)) {
    const ast = ts.createSourceFile(
      source,
      contents,
      ts.ScriptTarget.Latest,
      true,
    );
    const consumed = new Set<number>();
    const markers = new Map<number, string>();
    const recordedComments = new Set<number>();
    const recordComments = (
      ranges: readonly ts.CommentRange[] | undefined,
    ): void => {
      for (const range of ranges ?? []) {
        if (recordedComments.has(range.pos)) {
          continue;
        }
        recordedComments.add(range.pos);
        const match = /test-quarantine-expires:\s*(\S+)/u.exec(
          contents.slice(range.pos, range.end),
        );
        if (match) {
          markers.set(range.pos, match.at(1) ?? "");
        }
      }
    };
    const collectComments = (node: ts.Node): void => {
      recordComments(ts.getLeadingCommentRanges(contents, node.getFullStart()));
      recordComments(ts.getTrailingCommentRanges(contents, node.getEnd()));
      ts.forEachChild(node, collectComments);
    };
    collectComments(ast);
    if (markers.size === 0) {
      continue;
    }
    const diagnostics =
      ts.transpileModule(contents, {
        fileName: source,
        reportDiagnostics: true,
      }).diagnostics ?? [];
    if (
      diagnostics.some(
        ({ category }) => category === ts.DiagnosticCategory.Error,
      )
    ) {
      panic(`Test quarantine owner does not parse: ${source}`);
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "skip" &&
        ["test", "it"].includes(node.expression.expression.getText(ast))
      ) {
        const markersHere = [...markers].filter(
          ([offset]) =>
            offset >= node.getFullStart() && offset < node.getStart(ast),
        );
        if (markersHere.length > 0) {
          const marker = markersHere.at(0);
          const title = node.arguments.at(0);
          if (
            markersHere.length !== 1 ||
            !marker ||
            !title ||
            !ts.isStringLiteral(title)
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
            line:
              ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
            id: title.text,
            kind: "quarantined-test",
            expiresAt,
            probe: {
              command: testProbeCommand({ file: source, title: title.text }),
              attempts: TEST_ATTEMPTS,
            },
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (consumed.size !== markers.size) {
      panic(`Unowned dated test quarantine marker: ${source}`);
    }
  }
  return entries;
};

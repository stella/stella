/**
 * One owner for "the previous completed run of this document": the review
 * carry-over core. A feature that carries a reviewer's work to a re-run
 * calls `previousCompletedRunQuery`; a hand-written lookup elsewhere (a
 * completed-status filter and an exclusion of the run itself on the same
 * table) is refused here.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

import { guardEnforcesLine } from "../../../../../scripts/guard-rollouts.ts";

const API_SOURCE = path.resolve(import.meta.dir, "../..");
const OWNER = "lib/document-review/carry-over-core.ts";
// Registered in scripts/guard-rollouts: enforced on changed lines first.
const PREVIOUS_RUN_GUARD = "previous-completed-run-owner";

const EXCLUDED = /\.(?:test|spec|type-test)\.tsx?$|\/__fixtures__\//u;
const SELF_EXCLUSION = /\bne\(\s*([A-Za-z_$][\w$]*)\.id\s*,/gu;

const lineAt = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

/** The tables a source both filters to completed runs and excludes one run
 *  of by id, with the lines of both predicates: the shape of a "previous
 *  completed run" lookup. A change to either line makes the site new. */
const previousCompletedRunSites = (
  source: string,
): { table: string; line: number; lines: number[] }[] =>
  [...source.matchAll(SELF_EXCLUSION)].flatMap((match) => {
    const [, table] = match;
    if (table === undefined) {
      return [];
    }
    const completed = new RegExp(
      String.raw`\beq\(\s*${table}\.status\s*,\s*"completed"\s*\)`,
      "gu",
    );
    const completedLines = [...source.matchAll(completed)].map((found) =>
      lineAt(source, found.index),
    );
    if (completedLines.length === 0) {
      return [];
    }
    const line = lineAt(source, match.index);
    return [{ table, line, lines: [line, ...completedLines] }];
  });

const previousCompletedRunTables = (source: string): string[] =>
  previousCompletedRunSites(source).map(({ table }) => table);

describe("previous completed run lookup", () => {
  test("the detector recognises a hand-written lookup", () => {
    const handWritten = `
      tx.select({ id: legalListVerificationRuns.id })
        .from(legalListVerificationRuns)
        .where(and(
          eq(legalListVerificationRuns.entityId, run.entityId),
          eq(legalListVerificationRuns.status, "completed"),
          ne(legalListVerificationRuns.id, run.id),
        ))`;
    expect(previousCompletedRunTables(handWritten)).toEqual([
      "legalListVerificationRuns",
    ]);
    // A self-exclusion without the completed filter is another question.
    expect(
      previousCompletedRunTables(
        'ne(documentProcessingRuns.id, run.id), eq(documentProcessingRuns.status, "queued")',
      ),
    ).toEqual([]);
  });

  test("only the carry-over core looks up a document's previous completed run", async () => {
    const offenders: string[] = [];
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({
      cwd: API_SOURCE,
    })) {
      if (file === OWNER || EXCLUDED.test(file)) {
        continue;
      }
      const sites = previousCompletedRunSites(
        await Bun.file(path.join(API_SOURCE, file)).text(),
      ).filter(({ lines }) =>
        lines.some((line) =>
          guardEnforcesLine({
            guard: PREVIOUS_RUN_GUARD,
            file: `apps/api/src/${file}`,
            line,
          }),
        ),
      );
      if (sites.length > 0) {
        offenders.push(
          `${file}: ${sites.map(({ table, line }) => `${table} (line ${String(line)})`).join(", ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * One owner for "the previous completed run of this document": the review
 * carry-over core. A feature that carries a reviewer's work to a re-run
 * calls `previousCompletedRunQuery`; a hand-written lookup elsewhere (a
 * completed-status filter and an exclusion of the run itself on the same
 * table) is refused here.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const API_SOURCE = path.resolve(import.meta.dir, "../..");
const OWNER = "lib/review/carry-over.ts";

const EXCLUDED = /\.(?:test|spec|type-test)\.tsx?$|\/__fixtures__\//u;
const SELF_EXCLUSION = /\bne\(\s*([A-Za-z_$][\w$]*)\.id\s*,/gu;

/** The tables a source both filters to completed runs and excludes one run
 *  of by id: the shape of a "previous completed run" lookup. */
const previousCompletedRunTables = (source: string): string[] =>
  [...source.matchAll(SELF_EXCLUSION)].flatMap(([, table]) => {
    if (table === undefined) {
      return [];
    }
    const completed = new RegExp(
      String.raw`\beq\(\s*${table}\.status\s*,\s*"completed"\s*\)`,
      "u",
    );
    return completed.test(source) ? [table] : [];
  });

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
      const tables = previousCompletedRunTables(
        await Bun.file(path.join(API_SOURCE, file)).text(),
      );
      if (tables.length > 0) {
        offenders.push(`${file}: ${tables.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

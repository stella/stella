import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Both review executors write each batch of findings through
 * `writeReviewFindingBatch`, so the upsert, the progress recount and the
 * completion attempt cannot drift between them. The upsert is private to
 * finding-write.ts, which the compiler holds; this census covers the rest: a
 * module that writes the findings table directly, and an executor whose batch
 * path stops calling the shared step or completes a run around it. What the
 * shared step does for each executor is asserted in
 * table-run-findings.postgres.test.ts.
 */
const API_SRC = path.join(import.meta.dir, "../..");
const WRITING_MODULE = "lib/document-review/finding-write.ts";

const readSource = (file: string) =>
  readFileSync(path.join(API_SRC, file), "utf-8");

const INSERTS_FINDINGS = [
  /\.insert\(\s*documentReviewFindings\s*\)/u,
  /insert\s+into\s+\$\{\s*documentReviewFindings\s*\}/iu,
  /insert\s+into\s+"?document_review_findings"?/iu,
];

const findingInserters = (): string[] => {
  const glob = new Bun.Glob("**/*.ts");
  return [...glob.scanSync({ cwd: API_SRC })]
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => {
      const source = readSource(file);
      return INSERTS_FINDINGS.some((pattern) => pattern.test(source));
    })
    .toSorted();
};

const EXECUTORS = [
  { file: "lib/document-review/run-queue.ts", executor: "WORKER" },
  { file: "lib/document-review/table-run-findings.ts", executor: "TABLE" },
] as const;

describe("review finding writes", () => {
  test("only the shared write step inserts findings", () => {
    expect(findingInserters()).toEqual([WRITING_MODULE]);
  });

  test.each(EXECUTORS)(
    "$file writes its batches through the shared step",
    ({ file, executor }) => {
      const source = readSource(file);
      const sharedCall = new RegExp(
        String.raw`writeReviewFindingBatch\(\{[^}]*executor: DOCUMENT_REVIEW_RUN_EXECUTOR\.${executor}\b`,
        "u",
      );
      expect(source).toMatch(sharedCall);
      expect(source).not.toContain("upsertDocumentReviewFindings");
      // A table batch completes the run inside the shared step; the worker
      // completes once after its pass, through `finalizeWorkerRun`.
      expect(source).not.toMatch(/\bfinalizeReviewRun\(/u);
    },
  );
});

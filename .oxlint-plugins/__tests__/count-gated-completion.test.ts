import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  COUNT_GATED_COMPLETIONS,
  overlapProblem,
} from "../count-gated-completion.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "count-gated-completion";
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const FINALIZE_PATH = "apps/api/src/lib/document-review/run-finalize.ts";

const countGated = `
declare const tx: any;
export const finishWhenCounted = async () => {
  const counted = await tx.select({ value: count() }).from(findings);
  if (counted === expected) {
    await tx.update(runs).set({ status: "completed" });
  }
};
`;

describe.serial(RULE, () => {
  test("rejects an unregistered count-gated completion in scope", async () => {
    expect(
      await lintSingleRule(RULE, countGated, {
        cwd: "scratch",
        sourcePath: "apps/api/src/lib/workflow/planted.ts",
      }),
    ).toEqual([3]);
  });

  test("reads counts in raw SQL and terminal statuses through constants", async () => {
    const source = `
declare const tx: any;
const settle = async () => {
  await tx.execute(sql\`select count(*)::int from findings\`);
  await tx.update(runs).set({ status: RUN_STATUS.DONE });
};
`;
    expect(
      await lintSingleRule(RULE, source, {
        cwd: "scratch",
        sourcePath: "apps/api/src/lib/document-review/planted.ts",
      }),
    ).toEqual([3]);
  });

  test("accepts a count that only records progress", async () => {
    const source = `
declare const tx: any;
export const recordProgress = async () => {
  await tx.update(runs).set({ completed: await tx.$count(findings) });
};
`;
    expect(
      await lintSingleRule(RULE, source, {
        cwd: "scratch",
        sourcePath: "apps/api/src/lib/workflow/planted.ts",
      }),
    ).toEqual([]);
  });

  test("leaves code outside document review and workflow alone", async () => {
    expect(
      await lintSingleRule(RULE, countGated, {
        cwd: "scratch",
        sourcePath: "apps/api/src/lib/elsewhere/planted.ts",
      }),
    ).toEqual([]);
  });

  test("accepts the registered owner", async () => {
    const source = readFileSync(
      path.join(REPOSITORY_ROOT, FINALIZE_PATH),
      "utf-8",
    );
    expect(
      await lintSingleRule(RULE, source, {
        cwd: "scratch",
        sourcePath: FINALIZE_PATH,
      }),
    ).toEqual([]);
  });

  test("every registered overlap suite runs two clients on PostgreSQL", () => {
    for (const registration of COUNT_GATED_COMPLETIONS) {
      expect(overlapProblem(registration)).toBeNull();
    }
  });

  test("rejects a registration without a two-client PostgreSQL suite", () => {
    const [registration] = COUNT_GATED_COMPLETIONS;
    if (registration === undefined) {
      throw new Error("expected a registration");
    }
    expect(
      overlapProblem({
        ...registration,
        concurrencyTest:
          "apps/api/src/lib/document-review/run-finalize.test.ts",
      }),
    ).toContain("is not a *.postgres.test.ts suite");
    expect(
      overlapProblem({
        ...registration,
        concurrencyTest:
          "apps/api/src/lib/document-review/missing.postgres.test.ts",
      }),
    ).toContain("does not exist");
    expect(
      overlapProblem({
        ...registration,
        // A real PostgreSQL suite that never overlaps two clients.
        concurrencyTest:
          "apps/api/src/handlers/case-law/withdraw-document.postgres.test.ts",
      }),
    ).toContain("never opens two clients");
  });

  test("reports a registration whose function no longer counts", async () => {
    expect(
      await lintSingleRule(
        RULE,
        "export const finalizeReviewRun = () => 0;\n",
        {
          cwd: "scratch",
          sourcePath: FINALIZE_PATH,
        },
      ),
    ).toEqual([1]);
  });
});

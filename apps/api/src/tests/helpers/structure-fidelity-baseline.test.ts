import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { rejectionOf } from "@stll/property-testing/rejection";

import { updateStructureFidelityBaseline } from "../../../scripts/update-structure-fidelity-baseline";
import {
  assertStructureFidelityBaselineHistory,
  structureFidelityDrift,
} from "./structure-fidelity-baseline";
import type {
  STRUCTURE_FIDELITY_BASELINE_PATH,
  StructureFidelityCensus,
} from "./structure-fidelity-baseline";
import { structureFidelityRepositoryRoot } from "./structure-fidelity-census";

const finding = {
  rule: "sentence-cut",
  anchorId: "p1",
  excerpt: "Text continues",
} as const;
const census = (
  rows: StructureFidelityCensus[string][string],
): StructureFidelityCensus => ({
  source: { fixture: rows },
});

test("finding identity detects equal-count replacements and duplicate growth", () => {
  const before = census([finding]);
  for (const replacement of [
    { ...finding, anchorId: "p2" },
    { ...finding, excerpt: "Different text" },
    { ...finding, rule: "page-number-block" as const },
  ]) {
    const drift = structureFidelityDrift({
      actual: census([replacement]),
      expected: before,
    });
    expect(drift.added).toHaveLength(1);
    expect(drift.stale).toHaveLength(1);
  }
  expect(
    structureFidelityDrift({
      actual: census([finding, finding]),
      expected: before,
    }).added,
  ).toHaveLength(1);
  expect(
    structureFidelityDrift({ actual: census([]), expected: before }).stale,
  ).toHaveLength(1);
  expect(structureFidelityDrift({ actual: before, expected: before })).toEqual({
    added: [],
    stale: [],
  });
});

test("census roots decode spaces, Unicode and URL-significant characters", () => {
  const root = path.resolve("fixture root č # percent%");
  const module = path.join(
    root,
    "apps/api/src/tests/helpers/structure-fidelity-census.ts",
  );
  expect(structureFidelityRepositoryRoot(pathToFileURL(module).href)).toBe(
    root + path.sep,
  );
});

test("updater rejects working-file growth and committed growth, preserving the baseline", async () => {
  const root = mkdtempSync(
    path.join(import.meta.dir, "../../../../../.fidelity-history-"),
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const baselinePath = path.join(
    root,
    "apps/api/src/handlers/case-law/ingestion/parsers/structure-fidelity-baseline.json" satisfies typeof STRUCTURE_FIDELITY_BASELINE_PATH,
  );
  const write = (findings: StructureFidelityCensus) => {
    writeFileSync(
      baselinePath,
      JSON.stringify({ comment: "fixture", findings }),
    );
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
  };
  try {
    git("init", "--initial-branch=main");
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    write(census([finding]));
    commit();
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const growth = census([finding, { ...finding, anchorId: "p2" }]);
    write(growth);
    const edited = readFileSync(baselinePath, "utf-8");
    expect(
      await rejectionOf(
        updateStructureFidelityBaseline({
          repositoryRoot: root,
          baseRevision: "origin/main",
          collectCensus: async () => ({
            census: growth,
            documentedAdapters: new Set(["source"]),
          }),
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Structure-fidelity baseline cannot grow",
      ),
    });
    expect(readFileSync(baselinePath, "utf-8")).toBe(edited);
    commit();
    expect(() =>
      assertStructureFidelityBaselineHistory({
        repositoryRoot: root,
        baseRevision: "origin/main",
        findings: growth,
      }),
    ).toThrow("Structure-fidelity baseline cannot grow");
    await updateStructureFidelityBaseline({
      repositoryRoot: root,
      baseRevision: "origin/main",
      collectCensus: async () => ({
        census: census([]),
        documentedAdapters: new Set(["source"]),
      }),
    });
    expect(JSON.parse(readFileSync(baselinePath, "utf-8")).findings).toEqual(
      census([]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

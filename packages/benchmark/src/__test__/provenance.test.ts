import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { benchmarkGitRevision, benchmarkSourceGitSha } from "../git-revision";
import {
  renderSealedAggregateMarkdown,
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type SealedAggregateReport,
  serializeSealedAggregateReport,
} from "../sealed-report";

const temporaryRepositories: string[] = [];
const PROVENANCE_TEST_TIMEOUT_MS = 30_000;

const aggregateReport = (
  sourceGitSha: string,
  corpus: "meddocan" | "redactionbench" | "tab-echr",
): SealedAggregateReport => ({
  schemaVersion: SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  createdAt: "2026-01-02T03:04:05.678Z",
  sourceGitSha,
  runtime: "Bun test",
  policy: "evaluation-only",
  corpus: {
    id: corpus,
    source: "https://example.invalid/public-corpus",
    version: "pinned-version",
    file: "test.json",
    sha256: "a".repeat(64),
    license: "MIT",
    split: "test",
    documentCount: 1,
    selection: { type: "full-test-split" },
  },
  libraries: [
    {
      name: "stella",
      version: "test",
      status: "ok",
      timing: {
        initSeconds: 0.1,
        coldSeconds: 0.4,
        warmSeconds: 0.3,
        totalChars: 100,
      },
      adapterWallSeconds: 0.9,
      metrics: (() => {
        if (corpus === "tab-echr") {
          return {
            type: "tab-independent-annotator-span-redaction",
            documents: 1,
            directMentions: 1,
            quasiMentions: 1,
            directMentionRecall: 1,
            quasiMentionRecall: 1,
            allMentionRecall: 1,
            entityRecall: 1,
            characterPrecision: 1,
            characterRecall: 1,
            predictedSpans: 1,
          };
        }
        if (corpus === "redactionbench") {
          return {
            type: "redactionbench-transparent-interim",
            documents: 1,
            mandatorySpans: 1,
            mandatorySpanRecall: 1,
            mandatoryCharacterRecall: 1,
            acceptedCharacterPrecision: 1,
            predictedSpans: 1,
          };
        }
        return {
          type: "label-agnostic-span-redaction",
          spanRecall: 1,
          characterRecall: 1,
          characterPrecision: 1,
          goldSpans: 1,
        };
      })(),
    },
  ],
});

const writeAggregateReport = (
  root: string,
  report: SealedAggregateReport,
): void => {
  const suite = report.corpus.id === "tab-echr" ? "" : `${report.corpus.id}/`;
  const stamp = report.createdAt.replace(/[:.]/gu, "-");
  const prefix = join(
    root,
    `packages/benchmark/results/blind/${suite}${stamp}`,
  );
  mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(`${prefix}.json`, serializeSealedAggregateReport(report));
  writeFileSync(`${prefix}.md`, renderSealedAggregateMarkdown(report));
};

const git = (cwd: string, ...args: string[]): string => {
  const process = Bun.spawnSync(["git", ...args], { cwd });
  if (!process.success || process.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return process.stdout.toString().trim();
};

const repository = (): {
  readonly root: string;
  readonly fullSha: string;
  readonly shortSha: string;
} => {
  const root = mkdtempSync(join(tmpdir(), "anonymize-benchmark-provenance-"));
  temporaryRepositories.push(root);
  mkdirSync(join(root, "packages/benchmark/results/blind/redactionbench"), {
    recursive: true,
  });
  writeFileSync(
    join(root, ".gitignore"),
    "packages/benchmark/.venv-presidio\n",
  );
  writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
  writeFileSync(
    join(
      root,
      "packages/benchmark/results/blind/redactionbench/committed.json",
    ),
    "{}\n",
  );
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Benchmark Test",
    "-c",
    "user.email=benchmark@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return {
    root,
    fullSha: git(root, "rev-parse", "HEAD"),
    shortSha: git(root, "rev-parse", "--short", "HEAD"),
  };
};

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("benchmark Git provenance", () => {
  test(
    "ignores environments and untracked aggregate phase reports",
    () => {
      const { root, fullSha, shortSha } = repository();
      symlinkSync(root, join(root, "packages/benchmark/.venv-presidio"));
      writeAggregateReport(root, aggregateReport(fullSha, "tab-echr"));
      writeAggregateReport(root, aggregateReport(fullSha, "redactionbench"));
      writeAggregateReport(root, aggregateReport(fullSha, "meddocan"));

      expect(benchmarkGitRevision(root)).toBe(shortSha);
      expect(benchmarkSourceGitSha(root)).toBe(fullSha);
    },
    PROVENANCE_TEST_TIMEOUT_MS,
  );

  test(
    "does not ignore arbitrary or invalid report-looking files",
    () => {
      for (const relativePath of [
        "packages/benchmark/results/blind/failure-analysis.md",
        "packages/benchmark/results/blind/per-document.json",
        "packages/benchmark/results/blind/2026-01-02T03-04-05-678Z.json",
      ]) {
        const { root, shortSha } = repository();
        writeFileSync(join(root, relativePath), "{}\n");
        expect(benchmarkGitRevision(root)).toBe(`${shortSha}-dirty`);
        expect(() => benchmarkSourceGitSha(root)).toThrow(
          "clean Git source tree",
        );
        temporaryRepositories.splice(temporaryRepositories.indexOf(root), 1);
        rmSync(root, { recursive: true, force: true });
      }
    },
    PROVENANCE_TEST_TIMEOUT_MS,
  );

  test(
    "requires a current, canonical sealed report pair",
    () => {
      const invalid = repository();
      const invalidPrefix = join(
        invalid.root,
        "packages/benchmark/results/blind/2026-01-02T03-04-05-678Z",
      );
      writeFileSync(`${invalidPrefix}.json`, "{}\n");
      writeFileSync(`${invalidPrefix}.md`, "aggregate\n");
      expect(benchmarkGitRevision(invalid.root)).toBe(
        `${invalid.shortSha}-dirty`,
      );
      expect(() => benchmarkSourceGitSha(invalid.root)).toThrow(
        "clean Git source tree",
      );

      const stale = repository();
      writeAggregateReport(
        stale.root,
        aggregateReport("a".repeat(40), "tab-echr"),
      );
      expect(benchmarkGitRevision(stale.root)).toBe(`${stale.shortSha}-dirty`);

      const tampered = repository();
      const report = aggregateReport(tampered.fullSha, "tab-echr");
      writeAggregateReport(tampered.root, report);
      const stamp = report.createdAt.replace(/[:.]/gu, "-");
      writeFileSync(
        join(tampered.root, `packages/benchmark/results/blind/${stamp}.md`),
        "non-aggregate analysis\n",
      );
      expect(benchmarkGitRevision(tampered.root)).toBe(
        `${tampered.shortSha}-dirty`,
      );
    },
    PROVENANCE_TEST_TIMEOUT_MS,
  );

  test(
    "marks every other untracked file dirty",
    () => {
      const { root, fullSha, shortSha } = repository();
      const source = join(root, "packages/benchmark/unreviewed.ts");
      writeFileSync(source, "export {};\n");
      expect(benchmarkGitRevision(root)).toBe(`${shortSha}-dirty`);
      expect(() => benchmarkSourceGitSha(root)).toThrow(
        "clean Git source tree",
      );
      unlinkSync(source);
      expect(benchmarkGitRevision(root)).toBe(shortSha);
      expect(benchmarkSourceGitSha(root)).toBe(fullSha);
    },
    PROVENANCE_TEST_TIMEOUT_MS,
  );

  test(
    "marks tracked source and aggregate report modifications dirty",
    () => {
      const { root, shortSha } = repository();
      writeFileSync(join(root, "source.ts"), "export const value = 2;\n");
      expect(benchmarkGitRevision(root)).toBe(`${shortSha}-dirty`);
      git(root, "restore", "source.ts");
      writeFileSync(
        join(
          root,
          "packages/benchmark/results/blind/redactionbench/committed.json",
        ),
        '{"changed":true}\n',
      );
      expect(benchmarkGitRevision(root)).toBe(`${shortSha}-dirty`);
    },
    PROVENANCE_TEST_TIMEOUT_MS,
  );

  test(
    "marks staged changes dirty",
    () => {
      const { root, shortSha } = repository();
      writeFileSync(join(root, "source.ts"), "export const value = 3;\n");
      git(root, "add", "source.ts");
      expect(benchmarkGitRevision(root)).toBe(`${shortSha}-dirty`);
      expect(() => benchmarkSourceGitSha(root)).toThrow(
        "clean Git source tree",
      );
    },
    PROVENANCE_TEST_TIMEOUT_MS,
  );
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  assertSealedAggregateReport,
  normalizeSealedProviderVersion,
  renderSealedAggregateMarkdown,
  SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  type SealedAggregateReport,
  serializeSealedAggregateReport,
} from "../sealed-report";
import { parseVerifiedArtifact } from "../verified-artifact";
import { runSealedBoundary } from "../sealed-boundary";
import { BENCHMARK_CORPORA } from "../suite/registry";

const report = (): SealedAggregateReport => ({
  schemaVersion: SEALED_AGGREGATE_REPORT_SCHEMA_VERSION,
  createdAt: "2026-07-21T00:00:00.000Z",
  sourceGitSha: "0".repeat(40),
  runtime: "Bun test",
  policy: "evaluation-only",
  corpus: {
    id: "tab-echr",
    source: "https://example.invalid/public-corpus",
    version: "pinned-version",
    file: "test.json",
    sha256: "a".repeat(64),
    license: "MIT",
    split: "test",
    documentCount: 127,
    selection: { type: "full-test-split" },
  },
  libraries: [
    {
      name: "stella",
      version: "test",
      status: "ok",
      timing: {
        initSeconds: 0.25,
        coldSeconds: 1,
        warmSeconds: 0.5,
        totalChars: 1_000,
      },
      adapterWallSeconds: 1.8,
      metrics: {
        type: "tab-independent-annotator-span-redaction",
        documents: 127,
        directMentions: 10,
        quasiMentions: 20,
        directMentionRecall: 0.9,
        quasiMentionRecall: 0.8,
        allMentionRecall: 0.85,
        entityRecall: 0.75,
        characterPrecision: 0.7,
        characterRecall: 0.8,
        predictedSpans: 30,
      },
    },
  ],
});

describe("sealed aggregate report contract", () => {
  test("serializes one explicit aggregate-only schema", () => {
    const serialized = serializeSealedAggregateReport(report());
    const parsed: unknown = JSON.parse(serialized);
    expect(() => assertSealedAggregateReport(parsed)).not.toThrow();
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("serialized report must be an object");
    }
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "createdAt",
      "sourceGitSha",
      "runtime",
      "policy",
      "corpus",
      "libraries",
    ]);
    const markdown = renderSealedAggregateMarkdown(report());
    expect(markdown).toContain(
      "contains no source text, examples, categories, predictions, or per-document results",
    );
    expect(markdown).toContain("Warm chars/s");
    expect(markdown).toContain(
      "| stella | test | 90.0 | 80.0 | 85.0 | 75.0 | 70.0 | 80.0 | 0.25 | 1.00 | 0.50 | 2000 | 1.80 |",
    );
    expect(markdown).toContain("Adapter wall time is diagnostic only");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  test("renders one value for every TAB table column", () => {
    const rows = renderSealedAggregateMarkdown(report())
      .split("\n")
      .filter((line) => line.startsWith("| "));
    expect(rows).toHaveLength(3);
    expect(rows.map((line) => line.split("|").slice(1, -1).length)).toEqual([
      13, 13, 13,
    ]);
  });

  test("keeps German LER coverage distinct from anonymization recall", () => {
    const base = report();
    const first = base.libraries.at(0);
    if (first?.status !== "ok") {
      throw new Error("test report must be available");
    }
    const germanLer: SealedAggregateReport = {
      ...base,
      corpus: {
        ...base.corpus,
        id: "german-ler",
        documentCount: 6_673,
      },
      libraries: [
        {
          ...first,
          metrics: {
            type: "german-legal-entity-coverage",
            documents: 6_673,
            entityRecall: 0.4,
            characterRecall: 0.5,
            characterPrecision: 0.6,
            goldEntities: 5_322,
            predictedSpans: 2_000,
          },
        },
      ],
    };
    const markdown = renderSealedAggregateMarkdown(germanLer);
    expect(markdown).toContain("Entity coverage");
    expect(markdown).toContain("not PII recall or label-aware NER accuracy");
    expect(markdown).toContain("already anonymized before annotation");
  });

  test("rejects missing or invalid phase timing", () => {
    const base = report();
    const first = base.libraries.at(0);
    if (first?.status !== "ok")
      throw new Error("test report must be available");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [{ ...first, timing: { ...first.timing, warmSeconds: -1 } }],
      }),
    ).toThrow("warmSeconds must be finite and non-negative");
    const { timing: _timing, ...withoutTiming } = first;
    expect(() =>
      assertSealedAggregateReport({ ...base, libraries: [withoutTiming] }),
    ).toThrow("missing field timing");
  });

  test("requires every provider to use one corpus-size denominator", () => {
    const base = report();
    const first = base.libraries.at(0);
    if (first?.status !== "ok")
      throw new Error("test report must be available");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [
          first,
          {
            ...first,
            name: "other",
            timing: { ...first.timing, totalChars: 999 },
          },
        ],
      }),
    ).toThrow("totalChars does not match other providers");
  });

  test("keeps every current-schema sealed Markdown report canonical", () => {
    const rootResult = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
    if (!rootResult.success || rootResult.exitCode !== 0) {
      throw new Error("benchmark tests must run inside a Git repository");
    }
    const root = rootResult.stdout.toString().trim();
    const trackedResult = Bun.spawnSync(
      ["git", "ls-files", "-z", "--", "packages/benchmark/results/blind"],
      { cwd: root },
    );
    if (!trackedResult.success || trackedResult.exitCode !== 0) {
      throw new Error("could not enumerate committed benchmark reports");
    }
    const trackedPaths = trackedResult.stdout
      .toString()
      .split("\0")
      .filter((path) => path !== "");
    const trackedPathSet = new Set(trackedPaths);
    let aggregateReportCount = 0;
    for (const jsonPath of trackedPaths.filter((path) =>
      path.endsWith(".json"),
    )) {
      const parsed: unknown = JSON.parse(
        readFileSync(join(root, jsonPath), "utf8"),
      );
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !("schemaVersion" in parsed) ||
        typeof parsed.schemaVersion !== "number"
      ) {
        continue;
      }
      aggregateReportCount += 1;
      if (parsed.schemaVersion !== SEALED_AGGREGATE_REPORT_SCHEMA_VERSION) {
        continue;
      }
      assertSealedAggregateReport(parsed);
      const markdownPath = jsonPath.replace(/\.json$/u, ".md");
      expect(trackedPathSet.has(markdownPath)).toBe(true);
      expect(readFileSync(join(root, markdownPath), "utf8")).toBe(
        renderSealedAggregateMarkdown(parsed),
      );
    }
    // A schema bump intentionally precedes regeneration of sealed results.
    expect(aggregateReportCount).toBeGreaterThan(0);
  });

  test("latest held-out reports measure the current stella release", () => {
    const rootResult = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
    if (!rootResult.success || rootResult.exitCode !== 0) {
      throw new Error("benchmark tests must run inside a Git repository");
    }
    const root = rootResult.stdout.toString().trim();
    const packageJson: unknown = JSON.parse(
      readFileSync(join(root, "packages/anonymize/package.json"), "utf8"),
    );
    if (
      packageJson === null ||
      typeof packageJson !== "object" ||
      Array.isArray(packageJson) ||
      !("version" in packageJson) ||
      typeof packageJson.version !== "string"
    ) {
      throw new Error("anonymize package version is invalid");
    }

    const reportsResult = Bun.spawnSync(
      [
        "git",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "packages/benchmark/results/blind/*.json",
        "packages/benchmark/results/blind/**/*.json",
      ],
      { cwd: root },
    );
    if (!reportsResult.success || reportsResult.exitCode !== 0) {
      throw new Error("could not enumerate held-out benchmark reports");
    }

    const latestByCorpus = new Map<string, SealedAggregateReport>();
    for (const jsonPath of reportsResult.stdout
      .toString()
      .split("\0")
      .filter((path) => path !== "")) {
      const parsed: unknown = JSON.parse(
        readFileSync(join(root, jsonPath), "utf8"),
      );
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !("schemaVersion" in parsed) ||
        parsed.schemaVersion !== SEALED_AGGREGATE_REPORT_SCHEMA_VERSION
      ) {
        continue;
      }
      assertSealedAggregateReport(parsed);
      if (parsed.corpus.selection.type !== "full-test-split") {
        continue;
      }
      const previous = latestByCorpus.get(parsed.corpus.id);
      if (previous === undefined || previous.createdAt < parsed.createdAt) {
        latestByCorpus.set(parsed.corpus.id, parsed);
      }
    }

    const expectedCorpora = BENCHMARK_CORPORA.filter(
      ({ execution, policy, runnable }) =>
        runnable && policy === "evaluation-only" && execution !== undefined,
    );
    const expectedByCorpus = new Map(
      expectedCorpora.map((corpus) => [corpus.id, corpus]),
    );
    const expectedCorpusIds = [...expectedByCorpus.keys()].toSorted();
    expect([...latestByCorpus.keys()].toSorted()).toEqual(expectedCorpusIds);

    for (const corpusId of expectedCorpusIds) {
      const current = latestByCorpus.get(corpusId);
      const expected = expectedByCorpus.get(corpusId);
      if (expected?.artifact === undefined) {
        throw new Error(`${corpusId} has no pinned registry artifact`);
      }
      if (expected.artifact.split !== "test") {
        throw new Error(`${corpusId} does not pin the evaluation test split`);
      }
      expect(current?.corpus.source, `${corpusId} uses a stale source`).toBe(
        expected.source,
      );
      expect(current?.corpus.version, `${corpusId} uses a stale version`).toBe(
        expected.version,
      );
      expect(current?.corpus.file, `${corpusId} uses a stale artifact`).toBe(
        expected.artifact.file,
      );
      expect(current?.corpus.sha256, `${corpusId} uses a stale checksum`).toBe(
        expected.artifact.sha256,
      );
      expect(current?.corpus.split, `${corpusId} uses a stale split`).toBe(
        expected.artifact.split,
      );
      const stella = current?.libraries.find(({ name }) => name === "stella");
      expect(stella?.status, `${corpusId} must include stella`).toBe("ok");
      expect(stella?.version, `${corpusId} uses a stale stella version`).toBe(
        packageJson.version,
      );
    }
  });

  test("rejects text, examples, predictions, and per-document fields at every report boundary", () => {
    const base = report();
    expect(() =>
      assertSealedAggregateReport({ ...base, text: "forbidden" }),
    ).toThrow("forbidden field text");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [
          { ...base.libraries[0], predictions: [{ start: 0, end: 1 }] },
        ],
      }),
    ).toThrow("forbidden field predictions");
    const first = base.libraries.at(0);
    if (first?.status !== "ok")
      throw new Error("test report must be available");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [
          {
            ...first,
            metrics: { ...first.metrics, perDocument: [] },
          },
        ],
      }),
    ).toThrow("forbidden field perDocument");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        corpus: { ...base.corpus, id: "meddocan" },
      }),
    ).toThrow("metrics do not match the corpus");
  });

  test("rejects provider-controlled report-channel strings", () => {
    const base = report();
    const first = base.libraries.at(0);
    if (first?.status !== "ok") {
      throw new Error("test report must be available");
    }
    expect(() => normalizeSealedProviderVersion("4.8.0")).not.toThrow();
    expect(() =>
      normalizeSealedProviderVersion("pii-shield 2.2.0"),
    ).not.toThrow();
    expect(() => normalizeSealedProviderVersion("2.0.1\nsecret")).toThrow(
      "provider version is invalid",
    );
    expect(() => normalizeSealedProviderVersion("x".repeat(129))).toThrow(
      "provider version is invalid",
    );
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [{ ...first, name: "stella\nsecret" }],
      }),
    ).toThrow("name is invalid");
    expect(() =>
      assertSealedAggregateReport({
        ...base,
        libraries: [
          {
            name: "scrubadub",
            version: "2.0.1",
            status: "unavailable",
            reasonCode: "adapter-unavailable",
            reason: "subprocess-controlled detail",
          },
        ],
      }),
    ).toThrow("forbidden field reason");
  });

  test("requires the full source SHA without accepting the legacy field", () => {
    const base = report();
    expect(() =>
      assertSealedAggregateReport({ ...base, sourceGitSha: "0123456" }),
    ).toThrow("must be a full Git SHA");
    const { sourceGitSha: _sourceGitSha, ...withoutSourceGitSha } = base;
    expect(() =>
      assertSealedAggregateReport({
        ...withoutSourceGitSha,
        gitSha: "0".repeat(40),
      }),
    ).toThrow("forbidden field gitSha");
  });
});

describe("sealed artifact boundary", () => {
  test("does not invoke a parser until the pinned digest matches", async () => {
    const bytes = new TextEncoder().encode("public synthetic artifact");
    let parserCalls = 0;
    const parse = (): number => {
      parserCalls += 1;
      return parserCalls;
    };
    let mismatch: unknown;
    try {
      await parseVerifiedArtifact({
        bytes,
        expectedSha256: "0".repeat(64),
        name: "test artifact",
        parse,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(Error);
    expect(String(mismatch)).toContain("checksum mismatch before parsing");
    expect(parserCalls).toBe(0);

    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const parsed = await parseVerifiedArtifact({
      bytes,
      expectedSha256,
      name: "test artifact",
      parse,
    });
    expect(parsed).toBe(1);
    expect(parserCalls).toBe(1);
  });

  test("suppresses corpus and adapter failure details", async () => {
    let failure: unknown;
    try {
      await runSealedBoundary("sealed test operation", () =>
        Promise.reject(
          new Error("forbidden document identifier and prediction"),
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe(
      "Error: sealed test operation failed; sealed details suppressed",
    );
  });
});

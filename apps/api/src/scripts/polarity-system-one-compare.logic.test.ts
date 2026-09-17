/**
 * What the System One polarity comparison counts, and what it refuses.
 *
 * The runner reads the live corpus and calls a paid model, so every number the
 * report prints is driven here instead: the argument fences, the sample plan,
 * the confusion matrix over the canonical vocabularies, the agreement split
 * that keeps `unknown` and an absent label out of the score, the acceptance
 * curve the cascade's floor is set from, the percentiles and the cost.
 */

import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CLASSIFIABLE_POLARITIES,
  POLARITY,
} from "@/api/handlers/case-law/polarity/consts";
import type { ClassifiablePolarity } from "@/api/handlers/case-law/polarity/consts";

import {
  acceptanceCurve,
  buildConfusionMatrix,
  CONFIDENCE_FLOORS,
  DEFAULT_CONCURRENCY,
  DEFAULT_OUT_DIR,
  DEFAULT_SAMPLE_LIMIT,
  DEFAULT_SEED,
  disagreements,
  EXCERPT_MAX_CHARS,
  MAX_CONCURRENCY,
  percentileOf,
  parseCompareArgs,
  planSampleBuckets,
  renderComparisonReport,
  STORED_LABEL_ABSENT,
  STORED_LABELS,
  storedLabelOf,
  summariseComparison,
  truncateExcerpt,
  UNSCORED_STORED_LABELS,
} from "./polarity-system-one-compare.logic";
import type {
  ComparisonRow,
  CompareOptions,
  JevOutcome,
  LlmOutcome,
  StoredLabel,
} from "./polarity-system-one-compare.logic";

/** A round rate, so the cost assertions read as arithmetic and not as a price. */
const USD_PER_INPUT_TOKEN = 1e-6;

const evenProbabilities = (
  polarity: ClassifiablePolarity,
): Record<ClassifiablePolarity, number> => ({
  positive: polarity === POLARITY.POSITIVE ? 0.7 : 0.1,
  supportive: polarity === POLARITY.SUPPORTIVE ? 0.7 : 0.1,
  neutral: polarity === POLARITY.NEUTRAL ? 0.7 : 0.1,
  negative: polarity === POLARITY.NEGATIVE ? 0.7 : 0.1,
});

const reading = ({
  polarity,
  confidence = 0.8,
  latencyMs = 100,
  inputTokens = 500,
}: {
  polarity: ClassifiablePolarity;
  confidence?: number;
  latencyMs?: number;
  inputTokens?: number;
}): JevOutcome => ({
  status: "read",
  polarity,
  probabilities: evenProbabilities(polarity),
  confidence,
  latencyMs,
  inputTokens,
  model: "jev-1",
});

let nextRow = 0;

const comparisonRow = ({
  stored,
  jev,
  llm = { status: "not-run" },
  excerpt = "…v souladu s rozsudkem Nejvyššího soudu…",
}: {
  stored: StoredLabel;
  jev: JevOutcome;
  llm?: LlmOutcome;
  excerpt?: string;
}): ComparisonRow => {
  nextRow += 1;
  return {
    citationId: `citation-${nextRow}`,
    citingDecisionId: `citing-${nextRow}`,
    citedDecisionId: `cited-${nextRow}`,
    caseNumber: `30 Cdo ${nextRow}/2024`,
    court: "Nejvyšší soud",
    language: "cs",
    citationText: "sp. zn. 30 Cdo 1/2020",
    excerpt,
    stored,
    jev,
    llm,
  };
};

const options: CompareOptions = {
  limit: 12,
  language: "cs",
  stratify: true,
  seed: "seed",
  concurrency: 4,
  outDir: "/tmp/polarity",
  llm: false,
  model: null,
};

const parsedOptions = (argv: readonly string[]): CompareOptions => {
  const parsed = parseCompareArgs(argv);
  if (Result.isError(parsed)) {
    panic("expected the arguments to parse", parsed.error.message);
  }
  if (parsed.value.type !== "options") {
    panic("expected options rather than help", parsed.value.type);
  }
  return parsed.value.options;
};

const parseError = (argv: readonly string[]): string => {
  const parsed = parseCompareArgs(argv);
  if (!Result.isError(parsed)) {
    panic("expected the arguments to be refused", argv);
  }
  return parsed.error.message;
};

describe("comparison arguments", () => {
  test("defaults every option that was not given", () => {
    expect(parsedOptions([])).toEqual({
      limit: DEFAULT_SAMPLE_LIMIT,
      language: null,
      stratify: true,
      seed: DEFAULT_SEED,
      concurrency: DEFAULT_CONCURRENCY,
      outDir: DEFAULT_OUT_DIR,
      llm: false,
      model: null,
    });
  });

  test("takes the sample off stratification only when asked", () => {
    expect(parsedOptions(["--no-stratify"]).stratify).toBe(false);
    expect(parsedOptions(["--stratify"]).stratify).toBe(true);
  });

  test("refuses contradicting stratification flags", () => {
    expect(parseError(["--stratify", "--no-stratify"])).toContain("contradict");
  });

  test("reads the remaining flags", () => {
    expect(
      parsedOptions([
        "--limit",
        "40",
        "--language",
        "SK",
        "--seed",
        "2026-09-17",
        "--concurrency",
        "2",
        "--out",
        "/tmp/out",
        "--llm",
        "--model",
        "jev-2026-09",
      ]),
    ).toEqual({
      limit: 40,
      language: "sk",
      stratify: true,
      seed: "2026-09-17",
      concurrency: 2,
      outDir: "/tmp/out",
      llm: true,
      model: "jev-2026-09",
    });
  });

  test("reports help rather than parsing options", () => {
    const parsed = parseCompareArgs(["--help"]);
    expect(Result.isOk(parsed) && parsed.value.type).toBe("help");
  });

  test("refuses a typo instead of running against a default", () => {
    expect(parseError(["--limt", "10"])).toContain("unknown option: --limt");
    expect(parseError(["10"])).toContain("unexpected argument: 10");
    expect(parseError(["--limit"])).toContain("--limit requires a value");
    expect(parseError(["--limit", "10", "--limit", "20"])).toContain(
      "more than once",
    );
  });

  test("refuses a sample size or concurrency the run cannot honour", () => {
    expect(parseError(["--limit", "0"])).toContain("positive integer");
    expect(parseError(["--limit", "ten"])).toContain("positive integer");
    expect(parseError(["--concurrency", `${MAX_CONCURRENCY + 1}`])).toContain(
      `at most ${MAX_CONCURRENCY}`,
    );
  });

  test("refuses a language that is not a language code", () => {
    expect(parseError(["--language", "czech republic"])).toContain(
      "language code",
    );
  });
});

describe("sample plan", () => {
  test("covers every stored label, the absent one included", () => {
    const buckets = planSampleBuckets({ limit: 60, stratify: true });
    expect(
      buckets.map((bucket) =>
        bucket.scope === "stored-label" ? bucket.label : null,
      ),
    ).toEqual([...STORED_LABELS]);
    expect(buckets.map((bucket) => bucket.limit)).toEqual(
      STORED_LABELS.map(() => 10),
    );
  });

  test("spends the whole sample whatever the limit", () => {
    for (let limit = 1; limit <= 97; limit += 1) {
      const buckets = planSampleBuckets({ limit, stratify: true });
      const planned = buckets.reduce(
        (total, bucket) => total + bucket.limit,
        0,
      );
      expect(planned).toBe(limit);
      expect(buckets.every((bucket) => bucket.limit > 0)).toBe(true);
    }
  });

  test("draws from the population in one query when not stratified", () => {
    expect(planSampleBuckets({ limit: 25, stratify: false })).toEqual([
      { scope: "all", limit: 25 },
    ]);
  });
});

describe("stored labels", () => {
  test("separates a column that was never written from one that decided nothing", () => {
    expect(storedLabelOf(null)).toBe(STORED_LABEL_ABSENT);
    expect(storedLabelOf(POLARITY.UNKNOWN)).toBe(POLARITY.UNKNOWN);
    expect(UNSCORED_STORED_LABELS).toEqual([
      POLARITY.UNKNOWN,
      STORED_LABEL_ABSENT,
    ]);
  });

  test("refuses a stored value outside the polarity vocabulary", () => {
    expect(() => storedLabelOf("mildly-positive")).toThrow("POLARITIES");
  });
});

describe("excerpt truncation", () => {
  test("keeps a short window whole", () => {
    expect(truncateExcerpt("krátký úryvek")).toBe("krátký úryvek");
  });

  test("cuts by code point, never through a surrogate pair", () => {
    const text = "👩‍⚖️".repeat(EXCERPT_MAX_CHARS);
    // The fixture has to be longer than the cut in code points for the cut to
    // be reached at all.
    expect(Array.from(text)).not.toHaveLength(EXCERPT_MAX_CHARS);
    expect(Array.from(text).length).toBeGreaterThan(EXCERPT_MAX_CHARS);
    const truncated = truncateExcerpt(text);
    expect(Array.from(truncated)).toHaveLength(EXCERPT_MAX_CHARS);
    expect(truncated.endsWith("…")).toBe(true);
    // A cut by UTF-16 unit would leave a high surrogate with nothing after it.
    expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("percentiles", () => {
  test("answers nothing for an empty sample rather than zero", () => {
    expect(percentileOf([], 0.5)).toBeNull();
  });

  test("reports a value the sample actually holds", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentileOf(values, 0.5)).toBe(50);
    expect(percentileOf(values, 0.95)).toBe(100);
    expect(percentileOf([7], 0.95)).toBe(7);
  });
});

describe("confusion matrix", () => {
  test("is total over both vocabularies and counts unread rows apart", () => {
    const matrix = buildConfusionMatrix([
      comparisonRow({
        stored: POLARITY.POSITIVE,
        jev: reading({ polarity: POLARITY.POSITIVE }),
      }),
      comparisonRow({
        stored: POLARITY.POSITIVE,
        jev: reading({ polarity: POLARITY.NEUTRAL }),
      }),
      comparisonRow({
        stored: POLARITY.POSITIVE,
        jev: { status: "failed", kind: "http", message: "429" },
      }),
    ]);
    expect(matrix.map((row) => row.stored)).toEqual([...STORED_LABELS]);
    for (const row of matrix) {
      expect(row.byJev.map(({ label }) => label)).toEqual([
        ...CLASSIFIABLE_POLARITIES,
      ]);
    }
    const positive = matrix.find((row) => row.stored === POLARITY.POSITIVE);
    expect(positive).toMatchObject({ failed: 1, total: 3 });
    expect(
      positive?.byJev.find(({ label }) => label === POLARITY.NEUTRAL)?.count,
    ).toBe(1);
    expect(
      positive?.byJev.find(({ label }) => label === POLARITY.POSITIVE)?.count,
    ).toBe(1);
  });
});

describe("agreement", () => {
  const rows = [
    comparisonRow({
      stored: POLARITY.POSITIVE,
      jev: reading({ polarity: POLARITY.POSITIVE }),
    }),
    comparisonRow({
      stored: POLARITY.POSITIVE,
      jev: reading({ polarity: POLARITY.NEGATIVE }),
    }),
    comparisonRow({
      stored: POLARITY.NEUTRAL,
      jev: reading({ polarity: POLARITY.NEUTRAL }),
    }),
    comparisonRow({
      stored: POLARITY.UNKNOWN,
      jev: reading({ polarity: POLARITY.SUPPORTIVE }),
    }),
    comparisonRow({
      stored: STORED_LABEL_ABSENT,
      jev: reading({ polarity: POLARITY.NEUTRAL }),
    }),
  ];

  const summary = summariseComparison({
    rows,
    sampled: rows.length + 2,
    skipped: ["sections-missing", "sections-missing", "context-not-found"],
    usdPerInputToken: USD_PER_INPUT_TOKEN,
  });

  test("scores only the rows the corpus has a reading for", () => {
    expect(summary.agreement.overall).toEqual({
      compared: 3,
      agreed: 2,
      rate: 2 / 3,
    });
  });

  test("splits the score per stored label", () => {
    expect(summary.agreement.byStoredLabel).toEqual([
      { label: POLARITY.POSITIVE, compared: 2, agreed: 1, rate: 0.5 },
      { label: POLARITY.SUPPORTIVE, compared: 0, agreed: 0, rate: null },
      { label: POLARITY.NEUTRAL, compared: 1, agreed: 1, rate: 1 },
      { label: POLARITY.NEGATIVE, compared: 0, agreed: 0, rate: null },
    ]);
  });

  test("reports what the tier read where the corpus reads nothing", () => {
    expect(summary.unscored.map((entry) => entry.stored)).toEqual([
      POLARITY.UNKNOWN,
      STORED_LABEL_ABSENT,
    ]);
    expect(summary.unscored[0]?.read).toBe(1);
    expect(
      summary.unscored[0]?.byJev.find(
        ({ label }) => label === POLARITY.SUPPORTIVE,
      )?.count,
    ).toBe(1);
  });

  test("keeps the sample, the attempts and the skips separate", () => {
    expect(summary.sampled).toBe(rows.length + 2);
    expect(summary.attempted).toBe(rows.length);
    expect(summary.read).toBe(rows.length);
    expect(summary.skipped).toEqual([
      { label: "sections-missing", count: 2 },
      { label: "context-not-found", count: 1 },
    ]);
  });

  test("prices the run from the tokens the readings reported", () => {
    expect(summary.cost).toEqual({
      inputTokens: 500 * rows.length,
      usd: 500 * rows.length * USD_PER_INPUT_TOKEN,
      usdPerInputToken: USD_PER_INPUT_TOKEN,
    });
  });
});

describe("failures", () => {
  test("are counted by kind rather than read as a polarity", () => {
    const summary = summariseComparison({
      rows: [
        comparisonRow({
          stored: POLARITY.POSITIVE,
          jev: { status: "failed", kind: "http", message: "429" },
        }),
        comparisonRow({
          stored: POLARITY.NEUTRAL,
          jev: { status: "failed", kind: "network", message: "reset" },
        }),
      ],
      sampled: 2,
      skipped: [],
      usdPerInputToken: 1,
    });
    expect(summary.read).toBe(0);
    expect(summary.agreement.overall).toEqual({
      compared: 0,
      agreed: 0,
      rate: null,
    });
    expect(summary.failures.filter(({ count }) => count > 0)).toEqual([
      { label: "http", count: 1 },
      { label: "network", count: 1 },
    ]);
    expect(summary.cost.inputTokens).toBe(0);
  });
});

describe("acceptance curve", () => {
  const rows = [
    comparisonRow({
      stored: POLARITY.POSITIVE,
      jev: reading({ polarity: POLARITY.POSITIVE, confidence: 0.95 }),
    }),
    comparisonRow({
      stored: POLARITY.NEUTRAL,
      jev: reading({ polarity: POLARITY.NEUTRAL, confidence: 0.75 }),
    }),
    comparisonRow({
      stored: POLARITY.NEGATIVE,
      jev: reading({ polarity: POLARITY.NEUTRAL, confidence: 0.55 }),
    }),
    comparisonRow({
      stored: STORED_LABEL_ABSENT,
      jev: reading({ polarity: POLARITY.SUPPORTIVE, confidence: 0.99 }),
    }),
  ];

  test("trades coverage for agreement as the floor rises", () => {
    const curve = acceptanceCurve(rows);
    expect(curve.map((point) => point.floor)).toEqual([...CONFIDENCE_FLOORS]);
    expect(curve[0]).toEqual({
      floor: 0.5,
      accepted: 4,
      acceptedShare: 1,
      compared: 3,
      agreed: 2,
      rate: 2 / 3,
    });
    expect(curve[2]).toEqual({
      floor: 0.7,
      accepted: 3,
      acceptedShare: 0.75,
      compared: 2,
      agreed: 2,
      rate: 1,
    });
    expect(curve[4]).toEqual({
      floor: 0.9,
      accepted: 2,
      acceptedShare: 0.5,
      compared: 1,
      agreed: 1,
      rate: 1,
    });
  });

  test("never claims a rate over an empty acceptance", () => {
    const curve = acceptanceCurve(rows, [1.01]);
    expect(curve[0]).toMatchObject({ accepted: 0, compared: 0, rate: null });
  });
});

describe("the generative tier", () => {
  const rows = [
    comparisonRow({
      stored: POLARITY.POSITIVE,
      jev: reading({ polarity: POLARITY.POSITIVE }),
      llm: {
        status: "read",
        polarity: POLARITY.POSITIVE,
        confidence: 0.9,
        keyPhrase: "v souladu s",
        latencyMs: 900,
      },
    }),
    comparisonRow({
      stored: POLARITY.NEUTRAL,
      jev: reading({ polarity: POLARITY.NEUTRAL }),
      llm: {
        status: "read",
        polarity: POLARITY.SUPPORTIVE,
        confidence: 0.6,
        keyPhrase: "srov.",
        latencyMs: 1500,
      },
    }),
    comparisonRow({
      stored: POLARITY.NEGATIVE,
      jev: reading({ polarity: POLARITY.NEGATIVE }),
      llm: { status: "failed", message: "timeout" },
    }),
  ];

  test("is reported only when it ran", () => {
    expect(
      summariseComparison({
        rows: [
          comparisonRow({
            stored: POLARITY.POSITIVE,
            jev: reading({ polarity: POLARITY.POSITIVE }),
          }),
        ],
        sampled: 1,
        skipped: [],
        usdPerInputToken: 1,
      }).llm,
    ).toBeNull();
  });

  test("is scored against the corpus and against the System One tier", () => {
    const llm = summariseComparison({
      rows,
      sampled: rows.length,
      skipped: [],
      usdPerInputToken: 1,
    }).llm;
    expect(llm).not.toBeNull();
    expect(llm?.read).toBe(2);
    expect(llm?.failed).toBe(1);
    expect(llm?.agreementWithStored.overall).toEqual({
      compared: 2,
      agreed: 1,
      rate: 0.5,
    });
    expect(llm?.agreementWithJev).toEqual({
      compared: 2,
      agreed: 1,
      rate: 0.5,
    });
    expect(llm?.latency).toEqual({ samples: 2, p50: 900, p95: 1500 });
  });
});

describe("disagreements", () => {
  const rows = [
    comparisonRow({
      stored: POLARITY.POSITIVE,
      jev: reading({ polarity: POLARITY.POSITIVE }),
    }),
    comparisonRow({
      stored: POLARITY.NEUTRAL,
      jev: reading({ polarity: POLARITY.NEGATIVE }),
    }),
    comparisonRow({
      stored: POLARITY.UNKNOWN,
      jev: reading({ polarity: POLARITY.NEGATIVE }),
    }),
    comparisonRow({
      stored: POLARITY.SUPPORTIVE,
      jev: { status: "failed", kind: "network", message: "reset" },
    }),
  ];

  test("are the rows where both sides decided, and decided differently", () => {
    const examples = disagreements(rows, 10);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.stored).toBe(POLARITY.NEUTRAL);
  });

  test("are bounded by the caller's limit", () => {
    expect(disagreements([...rows, ...rows, ...rows], 2)).toHaveLength(2);
  });
});

describe("the Markdown report", () => {
  const agreed = comparisonRow({
    stored: POLARITY.POSITIVE,
    jev: reading({ polarity: POLARITY.POSITIVE }),
  });
  const rows = [
    agreed,
    comparisonRow({
      stored: POLARITY.NEUTRAL,
      jev: reading({ polarity: POLARITY.NEGATIVE, confidence: 0.61 }),
      excerpt: "…soud se odchýlil | od rozsudku\n  sp. zn. 30 Cdo 1/2020…",
    }),
  ];
  const markdown = renderComparisonReport({
    summary: summariseComparison({
      rows,
      sampled: 3,
      skipped: ["sections-missing"],
      usdPerInputToken: USD_PER_INPUT_TOKEN,
    }),
    options,
    rows,
    acceptFloor: 0.7,
    model: "jev-1",
  });

  test("carries every vocabulary the tables are built from", () => {
    for (const label of STORED_LABELS) {
      expect(markdown).toContain(`| ${label} |`);
    }
    for (const floor of CONFIDENCE_FLOORS) {
      expect(markdown).toContain(`| ${floor} |`);
    }
  });

  test("states the run it came from", () => {
    expect(markdown).toContain("seed `seed`");
    expect(markdown).toContain("stratified per stored label");
    expect(markdown).toContain("model jev-1");
    expect(markdown).toContain("it is 0.7 today");
  });

  test("keeps an excerpt inside its table cell", () => {
    const row =
      markdown.split("\n").find((line) => line.includes("odchýlil")) ??
      "no excerpt row";
    expect(row).toContain("\\|");
    expect(row.startsWith("| ")).toBe(true);
    expect(row).toContain("odchýlil \\| od rozsudku sp. zn.");
  });

  test("says so plainly when nothing disagreed", () => {
    expect(
      renderComparisonReport({
        summary: summariseComparison({
          rows: [agreed],
          sampled: 1,
          skipped: [],
          usdPerInputToken: 1,
        }),
        options,
        rows: [agreed],
        acceptFloor: 0.7,
        model: "jev-1",
      }),
    ).toContain("None: every compared citation");
  });
});

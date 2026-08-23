import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";

import type { NativePrediction } from "../adapters/types";
import {
  BENCHMARK_CORPORA,
  validateBenchmarkRegistry,
} from "../suite/registry";
import { parseRedactionBenchRows } from "../suite/redactionbench";
import { scoreRedactionBench } from "../suite/redactionbench-score";
import { parseMeddocanArchive } from "../suite/meddocan";
import { parseMultiGraSCCoArchive } from "../suite/multigrassco";
import { parseGermanLerRows } from "../suite/german-ler";
import { scoreSpanCorpus } from "../suite/span-score";

const rows = () => [
  {
    raw_text: "Jane at Acme",
    spans: [
      { start: 0, end: 4, label: "mandatory" },
      { start: 8, end: 12, label: "contextual" },
    ],
    category: "legal",
    genre: "contract",
    is_synthetic: true,
    original_document_url: null,
  },
];

describe("benchmark suite registry", () => {
  test("keeps development and sealed tasks explicit", () => {
    expect(() => validateBenchmarkRegistry()).not.toThrow();
    expect(
      BENCHMARK_CORPORA.some(
        ({ id, policy }) =>
          id === "tab-echr-development" && policy === "development",
      ),
    ).toBe(true);
    expect(BENCHMARK_CORPORA.some(({ id }) => id === "tab-echr")).toBe(true);
    expect(BENCHMARK_CORPORA.some(({ id }) => id === "meddocan")).toBe(true);
    expect(BENCHMARK_CORPORA.some(({ id }) => id === "multigrassco")).toBe(
      true,
    );
    expect(BENCHMARK_CORPORA.some(({ id }) => id === "german-ler")).toBe(true);
    expect(BENCHMARK_CORPORA.every(({ access }) => access !== undefined)).toBe(
      true,
    );
    expect(
      BENCHMARK_CORPORA.filter(
        ({ runnable, policy }) => runnable && policy === "evaluation-only",
      ).map(({ execution }) => execution?.script),
    ).toEqual([
      "blind.ts",
      "redactionbench.ts",
      "meddocan.ts",
      "multigrassco.ts",
      "german-ler.ts",
    ]);
    for (const corpus of BENCHMARK_CORPORA.filter(
      ({ policy }) => policy === "evaluation-only",
    )) {
      expect(corpus.access).toBe("verified-download");
      const artifact = corpus.artifact;
      if (artifact === undefined) {
        throw new Error(`${corpus.id} must pin an evaluation artifact`);
      }
      expect(["test", "evaluation"]).toContain(artifact.split);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });
});

describe("MultiGraSCCo normalization", () => {
  const languageNames = [
    "Arabic",
    "English",
    "French",
    "German",
    "Italian",
    "Persian",
    "Polish",
    "Russian",
    "Turkish",
    "Ukrainian",
  ];

  const archive = (staleLanguage?: string): Uint8Array => {
    const entries: Record<string, Uint8Array> = {};
    for (const language of languageNames) {
      const text = "😀 Alice visited Rome";
      const directStart = language === staleLanguage ? 3 : 2;
      const direct = [
        {
          filename: "example.json",
          text,
          entities: [
            { start: directStart, end: 7, text: "Alice", type: "NAME_PATIENT" },
          ],
        },
      ];
      const indirect = [
        {
          filename: "example.json",
          text,
          entities: [
            { start: 16, end: 20, text: "Rome", type: "ADDRESS_CITY" },
          ],
        },
      ];
      entries[`MultiGraSCCo/${language}_PHI.json`] = strToU8(
        JSON.stringify(direct),
      );
      entries[`MultiGraSCCo/${language}_IPI.json`] = strToU8(
        JSON.stringify(indirect),
      );
    }
    return zipSync(entries);
  };

  test("converts Unicode code-point annotations to UTF-16 spans", () => {
    const corpus = parseMultiGraSCCoArchive(archive(), 1);
    expect(corpus.sourceDocuments).toBe(10);
    expect(corpus.excludedDocuments).toBe(0);
    expect(corpus.documents.at(0)?.directSpans).toEqual([{ start: 3, end: 8 }]);
  });

  test("excludes a whole document instead of guessing a stale span", () => {
    const corpus = parseMultiGraSCCoArchive(archive("English"), 1);
    expect(corpus.documents).toHaveLength(9);
    expect(corpus.excludedDocuments).toBe(1);
  });
});

describe("German LER normalization", () => {
  test("reconstructs sentence offsets and validates coarse IOB2 tags", () => {
    expect(
      parseGermanLerRows([
        {
          id: "1",
          tokens: ["Das", "Bundesverfassungsgericht", "entschied", "."],
          "coarse-ner": ["O", "B-ORG", "O", "O"],
        },
      ]),
    ).toEqual([
      {
        id: "sentence-0",
        text: "Das Bundesverfassungsgericht entschied .",
        spans: [{ start: 4, end: 28, label: "ORG" }],
      },
    ]);
    expect(() =>
      parseGermanLerRows([
        { id: "1", tokens: ["Gericht"], "coarse-ner": ["I-ORG"] },
      ]),
    ).toThrow("invalid IOB2 sequence");
  });
});

describe("MEDDOCAN normalization", () => {
  test("loads paired BRAT text and annotations", () => {
    const archive = zipSync({
      "meddocan/test/brat/example.txt": strToU8("María"),
      "meddocan/test/brat/example.ann": strToU8(
        "T1\tNOMBRE_SUJETO_ASISTENCIA 0 5\tMaría\n",
      ),
    });
    expect(parseMeddocanArchive(archive, 1)).toEqual([
      {
        id: "example",
        text: "María",
        spans: [{ label: "NOMBRE_SUJETO_ASISTENCIA", start: 0, end: 5 }],
      },
    ]);
  });
});

describe("span-corpus metrics", () => {
  test("reports zero precision when an adapter masks nothing", () => {
    const score = scoreSpanCorpus(
      [{ id: "doc", text: "Jane", spans: [{ start: 0, end: 4 }] }],
      new Map(),
    );
    expect(score.spanRecall).toBe(0);
    expect(score.characterRecall).toBe(0);
    expect(score.characterPrecision).toBe(0);
  });
});

describe("RedactionBench normalization and interim metrics", () => {
  test("validates half-open mandatory and contextual spans", () => {
    const documents = parseRedactionBenchRows(rows());
    expect(documents.at(0)?.id).toBe("legal/contract");
    expect(documents.at(0)?.spans).toHaveLength(2);
    expect(() =>
      parseRedactionBenchRows([
        { ...rows()[0], spans: [{ start: 0, end: 99, label: "mandatory" }] },
      ]),
    ).toThrow("invalid span");
  });

  test("requires full mandatory spans but accepts contextual masks", () => {
    const documents = parseRedactionBenchRows(rows());
    const predictions = new Map<string, readonly NativePrediction[]>([
      [
        "legal/contract",
        [
          { start: 0, end: 3, label: "person", text: "Jan" },
          { start: 8, end: 12, label: "organization", text: "Acme" },
        ],
      ],
    ]);
    const score = scoreRedactionBench(documents, predictions);
    expect(score.mandatorySpanRecall).toBe(0);
    expect(score.mandatoryCharacterRecall).toBe(0.75);
    expect(score.acceptedCharacterPrecision).toBe(1);
  });
});

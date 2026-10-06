import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as v from "valibot";

import { envBase } from "@/api/env-base";
import {
  CorpusIndexError,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import { DECISION_TIMESTAMP_FIELD } from "@/api/lib/legal-search/corpus-index-config";
import {
  courtYearAggregation,
  parseCourtYearAggregation,
} from "@/api/lib/legal-search/corpus-index-court-year";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusYearRanges } from "@/api/lib/legal-search/corpus-index-search-facets";
import { foldCorpusTerm } from "@/api/lib/legal-search/corpus-passage-highlight";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { stemCorpusText } from "@/api/lib/legal-search/morphology/stem-text";

// Opt-in like the existing engine suites; record build identity with every
// contract and benchmark so measurements remain attributable to one engine.
const RUN_ENGINE = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";
const engineLabel = () =>
  engineBuilds.every(
    ({ version, commit }) =>
      version === "0.9.0" &&
      commit === "cc420c34d686a75f412b7cd450564c5c99ad6f21",
  )
    ? "stock 0.9.0"
    : "recorded engine build";
const engineBuilds: {
  endpoint: string;
  version: string;
  commit: string;
  target: string;
}[] = [];
const TIMEOUT_MS = 120_000;
const INDEX_ID = `query_features_contract_${Bun.randomUUIDv7().replaceAll("-", "")}`;
const DECISIONS = 120;
const PASSAGES = 10;
const COMPLETE_DECISIONS = 60;
const FAMILIES = [
  {
    name: "employment",
    base: 1000,
    terms: ["neplatnosť", "výpovede", "pracovného", "pomeru", "nadbytočnosť"],
  },
  {
    name: "limitation",
    base: 2000,
    terms: [
      "106",
      "občianskeho",
      "zákonníka",
      "premlčanie",
      "práva",
      "náhradu",
      "škody",
    ],
  },
  {
    name: "director",
    base: 3000,
    terms: ["odpovědnost", "jednatele", "péče", "řádného", "hospodáře"],
  },
] as const;

// Engine envelopes carry extra metadata; only the consumed fields are decoded.
const PassageSchema = v.object({
  decision_key: v.number(),
  passage_key: v.number(),
  family: v.string(),
  text: v.string(),
});
const SearchSchema = v.object({
  timed_out: v.boolean(),
  _shards: v.object({ failed: v.number() }),
  hits: v.object({
    total: v.object({ value: v.number(), relation: v.literal("eq") }),
    hits: v.array(
      v.object({ sort: v.array(v.number()), _source: PassageSchema }),
    ),
  }),
});
const AggregationSchema = v.object({
  aggregations: v.object({
    decisions: v.object({
      buckets: v.array(v.object({ key: v.number(), doc_count: v.number() })),
      sum_other_doc_count: v.number(),
      doc_count_error_upper_bound: v.number(),
    }),
  }),
});

type Passage = v.InferOutput<typeof PassageSchema>;
type Family = (typeof FAMILIES)[number];
type PassageTextOptions = { text: string; family?: string };
const passage = (
  decision_key: number,
  { text, family = "features" }: PassageTextOptions,
): Passage => ({
  decision_key,
  passage_key: decision_key * PASSAGES,
  family,
  text,
});

const MASK_ROWS = Array.from({ length: 8 }, (_slot1, mask) =>
  passage(10 + mask, {
    text:
      ["alpha", "beta", "gamma"]
        .filter((_slot2, bit) => Math.floor(mask / 2 ** bit) % 2 === 1)
        .join(" ") || "filler",
  }),
);
const FEATURES = [
  ...MASK_ROWS,
  passage(20, { text: "alpha alpha alpha" }),
  passage(21, { text: "alpha beta gamma", family: "outside" }),
  passage(30, { text: "NÁHRADA škody" }),
  passage(31, { text: "náhrada civilnej škody" }),
  passage(32, { text: "náhrada veľkej civilnej škody" }),
  passage(33, { text: "škody náhrada" }),
  passage(34, { text: "náhrada" }),
  passage(35, { text: "škody" }),
  passage(36, { text: "náhrada" }),
  { ...passage(36, { text: "škody" }), passage_key: 361 },
  passage(40, { text: "alpha filler" }),
  passage(41, { text: "beta filler" }),
];

// Independent coverage oracle: decision classes are assigned before text is
// generated. Never derive expected decision matches from the scanner below.
const benchmarkPassages = (family: Family): Passage[] =>
  Array.from({ length: DECISIONS }, (_slot3, decision) => {
    const terms =
      decision < COMPLETE_DECISIONS ? family.terms : family.terms.slice(0, -1);
    return Array.from({ length: PASSAGES }, (_slot4, seq) => {
      let content: readonly string[];
      switch (decision % 3) {
        case 0:
          content = terms;
          break;
        case 1:
          content = seq % 2 === 0 ? terms.slice(0, -1) : terms.slice(-1);
          break;
        case 2:
          content = [
            terms.at(seq % terms.length) ?? panic("empty term fixture"),
          ];
          break;
        default:
          return panic("invalid fixture class");
      }
      // Longer complete decisions and repeated short incomplete passages model
      // candidate pressure without pinning incidental BM25 tie ordering.
      const text =
        decision < COMPLETE_DECISIONS
          ? `${content.join(" ")} ${"konanie súd rozsudok ".repeat(40)}`
          : Array.from({ length: 8 }, () => content.join(" ")).join(" ");
      return {
        decision_key: family.base + decision,
        passage_key: (family.base + decision) * PASSAGES + seq,
        family: family.name,
        text,
      };
    });
  }).flat();

const documentId = (key: number) =>
  `00000000-0000-4000-8000-${key.toString(16).padStart(12, "0")}`;

const mutationBase = () =>
  envBase.CORPUS_INDEX_Q09_ENDPOINT ??
  panic("missing engine mutation endpoint");
const searchBase = () =>
  envBase.CORPUS_INDEX_Q09_SEARCH_ENDPOINT ??
  panic("missing engine search endpoint");

const request = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new CorpusIndexError({
      message: `engine contract HTTP ${response.status}: ${body}`,
      status: response.status,
    });
  }
  return { body };
};

const termClause = (term: string) => ({
  query_string: { query: `text:"${term}"`, default_operator: "AND" },
});
const groupQuery = (terms: readonly string[], minimum: number) => ({
  bool: { should: terms.map(termClause), minimum_should_match: minimum },
});
const familyQuery = (family: string, content: object) => ({
  bool: { must: [{ query_string: { query: `+family:${family}` } }, content] },
});

type SearchOptions = {
  query: object;
  size?: number;
  aggs?: object;
  sort?: string[];
};
const search = async ({
  query,
  size = 100,
  aggs,
  sort = ["_score"],
}: SearchOptions) => {
  const raw = await request(
    `${searchBase()}/api/v1/_elastic/${INDEX_ID}/_search?_source_includes=decision_key,passage_key,family,text`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, size, sort, aggs, track_total_hits: true }),
    },
  );
  const json: unknown = JSON.parse(raw.body);
  const result = v.parse(SearchSchema, json);
  expect(result.timed_out).toBe(false);
  expect(result._shards.failed).toBe(0);
  return {
    ...result,
    json,
  };
};
// bun-types declares `.rejects` matchers as void, so awaiting them trips
// type-aware lint; capture the rejection and assert on it directly.
const rejected = (error: unknown) => error;

const multiSearch = async (requests: readonly SearchOptions[]) => {
  const raw = await request(`${searchBase()}/api/v1/_elastic/_msearch`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: `${requests
      .flatMap(({ query, size = 100, aggs, sort = ["_score"] }) => [
        JSON.stringify({ index: INDEX_ID }),
        JSON.stringify({ query, size, sort, aggs, track_total_hits: true }),
      ])
      .join("\n")}\n`,
  });
  const { responses } = v.parse(
    v.object({ responses: v.array(v.unknown()) }),
    JSON.parse(raw.body),
  );
  expect(responses).toHaveLength(requests.length);
  return responses;
};

const keys = (result: v.InferOutput<typeof SearchSchema>) =>
  result.hits.hits
    .map(({ _source }) => _source.decision_key)
    .toSorted((a, b) => a - b);

const coveredDecisions = (
  hits: readonly Passage[],
  terms: readonly string[],
) => {
  const coverage = new Map<number, Set<string>>();
  for (const hit of hits) {
    const seen = coverage.get(hit.decision_key) ?? new Set<string>();
    for (const token of corpusTokens(hit.text)) {
      seen.add(foldCorpusTerm(token));
    }
    coverage.set(hit.decision_key, seen);
  }
  return [...coverage]
    .filter(([, tokens]) =>
      terms.every((term) => tokens.has(foldCorpusTerm(term))),
    )
    .map(([key]) => key)
    .toSorted((a, b) => a - b);
};

const aggregatePage = async (family: Family, pageSize: number) => {
  let intersection: Set<number> | undefined;
  // Each content group has independent numeric buckets; their intersection
  // proves coverage across passages without a document-level projection field.
  for (const term of family.terms) {
    const result = await search({
      query: familyQuery(family.name, termClause(term)),
      size: 0,
      aggs: {
        decisions: {
          terms: {
            field: "decision_key",
            size: DECISIONS,
            shard_size: DECISIONS,
            order: { _key: "asc" },
            show_term_doc_count_error: true,
          },
        },
      },
    });
    const aggregation = v.parse(AggregationSchema, result.json).aggregations
      .decisions;
    expect(aggregation.sum_other_doc_count).toBe(0);
    expect(aggregation.doc_count_error_upper_bound).toBe(0);
    const present = new Set(aggregation.buckets.map(({ key }) => key));
    intersection =
      intersection === undefined
        ? present
        : new Set([...intersection].filter((key) => present.has(key)));
  }
  const complete = [
    ...(intersection ?? panic("missing term aggregations")),
  ].toSorted((a, b) => a - b);
  expect(complete).toEqual(
    Array.from(
      { length: COMPLETE_DECISIONS },
      (_slot5, index) => family.base + index,
    ),
  );
  const decisions = complete.slice(0, pageSize);
  expect(decisions).toHaveLength(pageSize);
  const evidence = await search({
    query: familyQuery(family.name, {
      query_string: {
        query: decisions.map((key) => `decision_key:${key}`).join(" OR "),
      },
    }),
    size: pageSize * PASSAGES,
  });
  expect(evidence.hits.hits).toHaveLength(pageSize * PASSAGES);
  expect(
    coveredDecisions(
      evidence.hits.hits.map(({ _source }) => _source),
      family.terms,
    ),
  ).toEqual(decisions);
  return { decisions };
};

type CandidatePageOptions = { family: Family; minimum: number; window: number };
const candidatePage = async ({
  family,
  minimum,
  window,
}: CandidatePageOptions) => {
  const result = await search({
    query: familyQuery(family.name, groupQuery(family.terms, minimum)),
    size: window,
  });
  const decisions = coveredDecisions(
    result.hits.hits.map(({ _source }) => _source),
    family.terms,
  );
  expect(
    decisions.every(
      (key) => key >= family.base && key < family.base + COMPLETE_DECISIONS,
    ),
  ).toBe(true);
  return { decisions };
};

test("synthetic decision coverage includes split passages and rejects cross-decision unions", () => {
  for (const family of FAMILIES) {
    const rows = benchmarkPassages(family);
    expect(rows).toHaveLength(DECISIONS * PASSAGES);
    expect(new Set(rows.map(({ passage_key }) => passage_key)).size).toBe(
      rows.length,
    );
    expect(new Set(rows.map(({ decision_key }) => decision_key)).size).toBe(
      DECISIONS,
    );
    expect(coveredDecisions(rows, family.terms)).toEqual(
      Array.from(
        { length: COMPLETE_DECISIONS },
        (_slot6, index) => family.base + index,
      ),
    );
    const oneTermEach = rows.filter(
      ({ decision_key }) => decision_key === family.base + 2,
    );
    expect(
      oneTermEach.every(
        ({ text }) =>
          family.terms.filter((term) =>
            corpusTokens(text)
              .map(foldCorpusTerm)
              .includes(foldCorpusTerm(term)),
          ).length === 1,
      ),
    ).toBe(true);
    expect(coveredDecisions(oneTermEach, family.terms)).toEqual([
      family.base + 2,
    ]);
  }
  expect(
    coveredDecisions(
      [passage(1, { text: "alpha" }), passage(2, { text: "beta" })],
      ["alpha", "beta"],
    ),
  ).toEqual([]);
  expect(
    coveredDecisions(
      [passage(1, { text: "alpha alpha alpha" })],
      ["alpha", "beta"],
    ),
  ).toEqual([]);
});

let created = false;
describe.skipIf(!RUN_ENGINE)("query features on stock 0.9.0", () => {
  beforeAll(async () => {
    for (const base of new Set([mutationBase(), searchBase()])) {
      const raw = await request(`${base}/api/v1/version`);
      const identity = v.parse(
        v.object({
          build: v.object({
            commit_hash: v.string(),
            cargo_pkg_version: v.string(),
            build_target: v.string(),
          }),
        }),
        JSON.parse(raw.body),
      );
      engineBuilds.push({
        endpoint: base,
        version: identity.build.cargo_pkg_version,
        commit: identity.build.commit_hash,
        target: identity.build.build_target,
      });
    }
    const config = corpusIndexConfigFromManifest(
      CORPUS_INDEX_MANIFESTS.case_law_v7,
      INDEX_ID,
    );
    const canonicalFields = config.doc_mapping.field_mappings.filter(
      ({ name }) =>
        name === "text" ||
        name === "text_stem" ||
        name === "document_id" ||
        name === "court" ||
        name === DECISION_TIMESTAMP_FIELD,
    );
    expect(canonicalFields.map(({ name }) => name).toSorted()).toEqual([
      "court",
      "decision_date_ts",
      "document_id",
      "text",
      "text_stem",
    ]);
    await request(`${mutationBase()}/api/v1/indexes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: config.version,
        index_id: INDEX_ID,
        doc_mapping: {
          mode: "strict",
          tokenizers: config.doc_mapping.tokenizers,
          field_mappings: [
            ...canonicalFields,
            {
              name: "decision_key",
              type: "u64",
              fast: true,
              stored: true,
              indexed: true,
            },
            {
              name: "passage_key",
              type: "u64",
              fast: true,
              stored: true,
              indexed: true,
            },
            {
              name: "family",
              type: "text",
              tokenizer: "raw",
              stored: true,
              indexed: true,
              fast: false,
            },
          ],
        },
        indexing_settings: { merge_policy: { type: "no_merge" } },
        search_settings: { default_search_fields: ["text"] },
      }),
    });
    created = true;
    // One forced commit isolates boosting from split-local term statistics.
    const documents = [...FEATURES, ...FAMILIES.flatMap(benchmarkPassages)];
    await request(`${mutationBase()}/api/v1/${INDEX_ID}/ingest?commit=force`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${documents.map((row) => JSON.stringify({ ...row, document_id: documentId(row.decision_key), court: `court-${row.decision_key % 3}`, decision_date_ts: `${2020 + (row.decision_key % 2)}-06-01T00:00:00Z`, text_stem: stemCorpusText(row.text, "sk") })).join("\n")}\n`,
    });
    const census = await search({ query: { match_all: {} }, size: 0 });
    expect(census.hits.total.value).toBe(documents.length);
  }, TIMEOUT_MS);

  beforeEach(() => {
    console.info(
      JSON.stringify({
        contract: "query-feature-engine",
        engine: engineLabel(),
        builds: engineBuilds,
      }),
    );
  });

  afterAll(async () => {
    if (!created) {
      return;
    }
    await request(`${mutationBase()}/api/v1/indexes/${INDEX_ID}`, {
      method: "DELETE",
    });
  }, TIMEOUT_MS);

  test(
    "court/year aggregations count whole-query decisions within the facet latency budget",
    async () => {
      const yearRanges = corpusYearRanges(2026);
      const started = performance.now();
      const result = await getCorpusIndexClient("q09").aggregate({
        indexId: INDEX_ID,
        // All ten passages match: passage volume must never become the count.
        query: `decision_key:[1000 TO 1119]`,
        aggs: {
          courtYear: courtYearAggregation({
            decisionCountField: "document_id",
            yearRanges,
          }),
        },
      });
      expect(performance.now() - started).toBeLessThan(2000);
      if (Result.isError(result)) {
        throw result.error;
      }
      const matrix = parseCourtYearAggregation({
        aggregation: result.value["courtYear"],
        yearRanges,
      });
      expect(matrix).not.toBeNull();
      expect(matrix?.truncated).toBe(false);
      expect(matrix?.buckets).toHaveLength(6);
      expect(matrix?.buckets.reduce((sum, { count }) => sum + count, 0)).toBe(
        DECISIONS,
      );
      for (const bucket of matrix?.buckets ?? []) {
        expect(bucket.count).toBe(20);
      }
      // A matching non-opening passage still includes its decision in the year.
      const onePassage = await getCorpusIndexClient("q09").aggregate({
        indexId: INDEX_ID,
        query: "passage_key:10001",
        aggs: {
          courtYear: courtYearAggregation({
            decisionCountField: "document_id",
            yearRanges,
          }),
        },
      });
      if (Result.isError(onePassage)) {
        throw onePassage.error;
      }
      expect(
        parseCourtYearAggregation({
          aggregation: onePassage.value["courtYear"],
          yearRanges,
        })?.buckets,
      ).toEqual([{ court: "court-1", year: 2020, count: 1 }]);
    },
    TIMEOUT_MS,
  );

  test("multi-search preserves request order and standalone hits, including numeric term filters", async () => {
    const requests = [
      { query: { query_string: { query: "decision_key:40" } } },
      {
        query: {
          bool: {
            must: [termClause("alpha")],
            filter: [{ terms: { decision_key: [13, 17, 20, 41] } }],
          },
        },
      },
      { query: { query_string: { query: "decision_key:41" } } },
      { query: { query_string: { query: "decision_key:999999" } } },
    ].map(({ query }) => ({ query, sort: ["passage_key"], size: 50 }));
    const expectedKeys = [[40], [13, 17, 20], [41], []];
    const standalone = [];
    for (const [position, input] of requests.entries()) {
      const result = await search(input);
      expect(keys(result)).toEqual(
        expectedKeys.at(position) ?? panic("missing expected keys"),
      );
      standalone.push(result);
    }
    // Reverse and duplicate inputs so index grouping or result compaction
    // cannot accidentally satisfy the positional contract.
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0, 1],
    ]) {
      const batch = await multiSearch(
        order.map(
          (position) => requests.at(position) ?? panic("missing request"),
        ),
      );
      for (const [position, response] of batch.entries()) {
        const requestPosition = order.at(position) ?? panic("missing position");
        const expected =
          standalone.at(requestPosition) ?? panic("missing standalone result");
        const result = v.parse(SearchSchema, response);
        expect(result.timed_out).toBe(false);
        expect(result._shards.failed).toBe(0);
        expect(result.hits).toEqual(expected.hits);
      }
    }
  });

  test("multi-search isolates an unknown-field error without dropping successful items", async () => {
    const first = { query: { query_string: { query: "decision_key:40" } } };
    const last = { query: { query_string: { query: "decision_key:41" } } };
    const invalid = {
      query: { query_string: { query: "missing_contract_field:alpha" } },
    };
    for (const inputs of [
      [first, invalid, last],
      [invalid, first, last],
      [first, last, invalid],
    ]) {
      const responses = await multiSearch(inputs);
      for (const [position, input] of inputs.entries()) {
        const response = responses.at(position);
        if (input === invalid) {
          const failure = v.parse(
            v.object({
              status: v.literal(400),
              error: v.object({ reason: v.string() }),
            }),
            response,
          );
          expect(failure.error.reason).toContain("missing_contract_field");
          continue;
        }
        const result = v.parse(SearchSchema, response);
        const standalone = await search(input);
        expect(result.timed_out).toBe(false);
        expect(result._shards.failed).toBe(0);
        expect(result.hits).toEqual(standalone.hits);
        expect(keys(result)).toEqual(input === first ? [40] : [41]);
      }
    }
  });

  test("multi-search rejects malformed query bodies for the whole batch", async () => {
    const rejection = await multiSearch([
      { query: { query_string: { query: "decision_key:40" } } },
      { query: { bool: "invalid" } },
    ]).then(() => panic("multi-search accepted a malformed body"), rejected);
    expect(rejection).toMatchObject({
      status: 400,
      message: expect.stringContaining("failed to parse request body"),
    });
  });

  test("multi-search rejects payloads above the stock one-MiB limit", async () => {
    const rejection = await request(
      `${searchBase()}/api/v1/_elastic/_msearch`,
      {
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        body: " ".repeat(1024 * 1024 + 1),
        // The engine answers 413 before reading the body; a pooled socket
        // would hand the next request a connection the engine resets.
        keepalive: false,
      },
    ).then(() => panic("multi-search accepted an oversized payload"), rejected);
    expect(rejection).toMatchObject({ status: 413 });
  });

  test("multi-search accepts six term-filtered reads with two thousand document IDs", async () => {
    const selected = [13, 17, 20];
    const ids = [
      ...selected.map(documentId),
      ...Array.from({ length: 1997 }, (_, position) =>
        documentId(100_000 + position),
      ),
    ];
    expect(new Set(ids).size).toBe(2000);
    const requests = ["alpha", "beta", "gamma", "gamma", "beta", "alpha"].map(
      (term) => ({
        query: {
          bool: {
            must: [termClause(term)],
            filter: [{ terms: { document_id: ids } }],
          },
        },
        size: 50,
        sort: ["passage_key"],
      }),
    );
    const batch = await multiSearch(requests);
    const expected = [
      [13, 17, 20],
      [13, 17],
      [17],
      [17],
      [13, 17],
      [13, 17, 20],
    ];
    for (const [position, input] of requests.entries()) {
      const result = v.parse(SearchSchema, batch.at(position));
      const single = await search(input);
      expect(keys(result)).toEqual(
        expected.at(position) ?? panic("missing expected keys"),
      );
      expect(result.hits).toEqual(single.hits);
      expect(result.timed_out).toBe(false);
      expect(result._shards.failed).toBe(0);
    }
  });

  test("minimum_should_match counts distinct content groups and preserves required clauses", async () => {
    for (const minimum of [1, 2, 3]) {
      const result = await search({
        query: {
          bool: {
            must: [
              {
                query_string: {
                  query: "+family:features +decision_key:[10 TO 21]",
                },
              },
              groupQuery(["alpha", "beta", "gamma"], minimum),
            ],
          },
        },
      });
      const expected = MASK_ROWS.filter(
        (row) =>
          corpusTokens(row.text).length >= minimum && row.decision_key !== 10,
      ).map((row) => row.decision_key);
      if (minimum === 1) {
        expected.push(20);
      }
      expect(keys(result)).toEqual(expected);
    }
  });

  test("required clauses in the same boolean do not count towards minimum_should_match", async () => {
    const result = await search({
      query: {
        bool: {
          must: [
            {
              query_string: {
                query: "+family:features +decision_key:[10 TO 21]",
              },
            },
          ],
          should: ["alpha", "beta", "gamma"].map(termClause),
          minimum_should_match: 2,
        },
      },
    });
    expect(keys(result)).toEqual([13, 15, 16, 17]);
  });

  test("phrase slop respects gap boundaries, folding and precomputed stem positions", async () => {
    const expectedBySlop = [[30], [30, 31], [30, 31, 32, 33]];
    for (const field of ["text", "text_stem"]) {
      const phrase =
        field === "text"
          ? "nahrada skody"
          : stemCorpusText("náhrada škody", "sk");
      for (const [slop, expected] of expectedBySlop.entries()) {
        const result = await search({
          query: {
            query_string: {
              query: `decision_key:[30 TO 36] AND ${field}:"${phrase}"~${slop}`,
            },
          },
        });
        expect(keys(result)).toEqual(expected);
      }
    }
    const surface = await search({
      query: {
        query_string: { query: 'decision_key:30 AND text:"náhrada škoda"' },
      },
    });
    const stem = await search({
      query: {
        query_string: {
          query: `decision_key:30 AND text_stem:"${stemCorpusText("náhrada škoda", "sk")}"`,
        },
      },
    });
    expect(keys(surface)).toEqual([]);
    expect(keys(stem)).toEqual([30]);
  });

  test(
    "numeric decision buckets distinguish repeated passages from distinct term coverage",
    async () => {
      for (const family of FAMILIES) {
        const strict = await search({
          query: familyQuery(
            family.name,
            groupQuery(family.terms, family.terms.length),
          ),
          size: DECISIONS * PASSAGES,
        });
        expect([...new Set(keys(strict))]).toEqual(
          Array.from(
            { length: COMPLETE_DECISIONS / 3 },
            (_slot7, index) => family.base + index * 3,
          ),
        );
        const aggregated = await aggregatePage(family, 50);
        expect(aggregated.decisions).toEqual(
          Array.from({ length: 50 }, (_slot8, index) => family.base + index),
        );
        const relaxed = await candidatePage({
          family,
          minimum: 1,
          window: DECISIONS * PASSAGES,
        });
        expect(relaxed.decisions).toEqual(
          Array.from(
            { length: COMPLETE_DECISIONS },
            (_slot9, index) => family.base + index,
          ),
        );
        const narrowed = await candidatePage({
          family,
          minimum: family.terms.length - 1,
          window: DECISIONS * PASSAGES,
        });
        expect(narrowed.decisions).toEqual(
          Array.from(
            { length: COMPLETE_DECISIONS / 3 },
            (_slot10, index) => family.base + index * 3,
          ),
        );
      }
    },
    TIMEOUT_MS,
  );

  test("truncated numeric buckets cannot certify document-wide coverage", async () => {
    const family = FAMILIES[0];
    const result = await search({
      query: familyQuery(family.name, groupQuery(family.terms, 1)),
      size: 0,
      aggs: {
        decisions: {
          terms: {
            field: "decision_key",
            size: 10,
            shard_size: DECISIONS,
            order: { _key: "asc" },
            show_term_doc_count_error: true,
          },
        },
      },
    });
    const aggregation = v.parse(AggregationSchema, result.json).aggregations
      .decisions;
    expect(aggregation.buckets).toHaveLength(10);
    expect(aggregation.sum_other_doc_count).toBeGreaterThan(0);
  });

  test("positive per-clause boosts reverse ranking without changing membership", async () => {
    for (const [alpha, beta, first] of [
      [10, 1, 40],
      [1, 10, 41],
    ] as const) {
      const result = await search({
        query: {
          query_string: {
            query: `decision_key:[40 TO 41] AND (text:alpha^${alpha} OR text:beta^${beta})`,
          },
        },
      });
      expect(keys(result)).toEqual([40, 41]);
      expect(result.hits.hits.at(0)?._source.decision_key).toBe(first);
      const scores = result.hits.hits.map(
        ({ sort }) => sort.at(0) ?? panic("boost query has no score"),
      );
      expect(scores.at(0)).toBeGreaterThan(
        scores.at(1) ?? panic("missing second score"),
      );
    }
  });
});

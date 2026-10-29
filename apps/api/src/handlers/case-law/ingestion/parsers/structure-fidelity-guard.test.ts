import { afterAll, expect, test } from "bun:test";

import {
  listSourceRegistrations,
  type SourceRegistrationKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baseline from "@/api/handlers/case-law/ingestion/parsers/structure-fidelity-baseline.json";
import {
  collectStructureFidelityCensus,
  STRUCTURE_FIDELITY_FINDING_KINDS,
  type StructureFidelityCensus,
} from "@/api/tests/helpers/structure-fidelity-census";

/**
 * Every registered source's parser output is read from recorded fixtures, or
 * the source states why none is recorded. A source without one is a parser no
 * guard reads, which is how a printed-page defect class stays in one
 * jurisdiction after it is fixed in another.
 */
type FixtureCoverage =
  { type: "recorded" } | { type: "unrecorded"; reason: string };

const RECORDED = { type: "recorded" } as const satisfies FixtureCoverage;

const FIXTURE_COVERAGE = {
  "at-asylgh": RECORDED,
  "at-bks": RECORDED,
  "at-bvwg": RECORDED,
  "at-courts": RECORDED,
  "at-findok": RECORDED,
  "at-lvwg": RECORDED,
  "at-ubas": RECORDED,
  "at-umse": RECORDED,
  "at-uvs": RECORDED,
  "at-verg": RECORDED,
  "at-vfgh": RECORDED,
  "at-vwgh": RECORDED,
  "cz-ns": RECORDED,
  "cz-nss": RECORDED,
  "cz-regional": RECORDED,
  "cz-uohs": RECORDED,
  "cz-us": RECORDED,
  "eu-ecj": RECORDED,
  "hu-bhgy": RECORDED,
  "pl-courts": RECORDED,
  "pl-kio": RECORDED,
  "pl-kis": RECORDED,
  "pl-ncourt": RECORDED,
  "pl-nsa": RECORDED,
  "pl-sn": RECORDED,
  "pl-tk": RECORDED,
  "pl-uodo": RECORDED,
  "pl-uokik": RECORDED,
  "sk-courts": {
    type: "unrecorded",
    reason:
      "Decision documents are PDFs the deferred document walk parses; the parser-output harness replays no recorded PDF for this source yet.",
  },
  "sk-us": RECORDED,
  "uk-fcl": RECORDED,
  "us-courtlistener": RECORDED,
} as const satisfies Record<SourceRegistrationKey, FixtureCoverage>;

const BASELINE_PATH =
  "apps/api/src/handlers/case-law/ingestion/parsers/structure-fidelity-baseline.json";
const UPDATE_COMMAND =
  "bun apps/api/scripts/update-structure-fidelity-baseline.ts";

const originalFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

// Replaying every adapter's fixtures is the expensive step; both tests read
// the one census.
const censusResult = collectStructureFidelityCensus();

const COLLECTION_TIMEOUT_MS = 180_000;

// timeout: awaits the census, which replays every registered source's recorded fixtures through its parser.
test(
  "every registered source is read from recorded fixtures or states why not",
  async () => {
    const { documentedAdapters } = await censusResult;
    const registered = listSourceRegistrations().map(({ key }) => key);
    const mismatches = registered.flatMap((key) => {
      const coverage = FIXTURE_COVERAGE[key];
      const documented = documentedAdapters.has(key);
      switch (coverage.type) {
        case "recorded":
          return documented
            ? []
            : [`${key}: marked recorded, but no fixture yields a document`];
        case "unrecorded":
          return documented
            ? [`${key}: now has a recorded document; mark it recorded`]
            : [];
        default: {
          coverage satisfies never;
          return [];
        }
      }
    });
    expect(mismatches).toEqual([]);
  },
  COLLECTION_TIMEOUT_MS,
);

type CensusDrift = { added: string[]; stale: string[] };

const driftOf = (
  actual: StructureFidelityCensus,
  expected: StructureFidelityCensus,
): CensusDrift => {
  const added: string[] = [];
  const stale: string[] = [];
  const adapters = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const adapter of adapters) {
    const fixtures = new Set([
      ...Object.keys(actual[adapter] ?? {}),
      ...Object.keys(expected[adapter] ?? {}),
    ]);
    for (const fixture of fixtures) {
      for (const kind of STRUCTURE_FIDELITY_FINDING_KINDS) {
        const now = actual[adapter]?.[fixture]?.[kind] ?? 0;
        const before = expected[adapter]?.[fixture]?.[kind] ?? 0;
        const where = `${adapter} / ${fixture} / ${kind}: ${before} -> ${now}`;
        if (now > before) {
          added.push(where);
        } else if (now < before) {
          stale.push(where);
        }
      }
    }
  }
  return { added, stale };
};

// timeout: awaits the census, which replays every registered source's recorded fixtures through its parser.
test(
  "structure-fidelity findings only shrink",
  async () => {
    const { census } = await censusResult;
    const { added, stale } = driftOf(census, baseline.findings);
    // A new finding is a parser storing printed-page layout as structure:
    // fix the parser through the shared owners (hard-wrapped-lines.ts,
    // page-furniture.ts, letter-spacing.ts), never by raising the baseline.
    expect(added).toEqual([]);
    // A finding the parsers no longer produce leaves the baseline, so the
    // ratchet keeps the gain.
    expect(
      stale.length === 0
        ? []
        : [`Run ${UPDATE_COMMAND} to lower ${BASELINE_PATH}:`, ...stale],
    ).toEqual([]);
  },
  COLLECTION_TIMEOUT_MS,
);

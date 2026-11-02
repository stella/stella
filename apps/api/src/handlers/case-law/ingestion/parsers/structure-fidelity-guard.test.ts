import { beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import {
  listSourceRegistrations,
  type SourceRegistrationKey,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baselineJson from "@/api/handlers/case-law/ingestion/parsers/structure-fidelity-baseline.json";
import {
  assertStructureFidelityBaselineHistory,
  structureFidelityBaselineSchema,
  structureFidelityDrift,
} from "@/api/tests/helpers/structure-fidelity-baseline";
import { collectStructureFidelityCensus } from "@/api/tests/helpers/structure-fidelity-census";
import { withTestFetchInterceptor } from "@/api/tests/helpers/test-fetch";

const baseline = v.parse(structureFidelityBaselineSchema, baselineJson);

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

// Replaying every adapter's fixtures is the expensive step; both tests read
// the one census.
let censusResult: Awaited<ReturnType<typeof collectStructureFidelityCensus>>;

const COLLECTION_TIMEOUT_MS = 180_000;

// timeout: the census replays every registered source's recorded fixtures through its parser.
beforeAll(async () => {
  censusResult = await withTestFetchInterceptor(
    async (input, init, delegate) => await delegate(input, init),
    collectStructureFidelityCensus,
  );
}, COLLECTION_TIMEOUT_MS);

// timeout: awaits the census, which replays every registered source's recorded fixtures through its parser.
test(
  "every registered source is read from recorded fixtures or states why not",
  () => {
    const { documentedAdapters } = censusResult;
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

// timeout: awaits the census, which replays every registered source's recorded fixtures through its parser.
test(
  "structure-fidelity findings only shrink",
  () => {
    const { census } = censusResult;
    assertStructureFidelityBaselineHistory({
      repositoryRoot: fileURLToPath(
        new URL("../../../../../../../", import.meta.url),
      ),
      findings: baseline.findings,
    });
    const { added, stale } = structureFidelityDrift({
      actual: census,
      expected: baseline.findings,
    });
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

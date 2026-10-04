// Every registered adapter's publisher reads, driven with failures.
//
// Each adapter's enrolled fixture is built once as served, recording the
// fetch stages it reads, then once per stage × fault (500, timeout, empty 204,
// empty 200 body) with every request of that stage failing. A faulted build
// must fail or build exactly the control decision; a build that succeeds with
// different content stored a failed read as missing or empty fields.
//
// Rows in read-fault-guard-baseline.json are the current exceptions: an
// adapter whose fixture drives no publisher read (`<adapter>::undriven`) or a
// stage × fault that degrades the decision. New rows fail; rows that no longer
// occur must be removed. scripts/failure-as-empty-baseline.ts rejects added
// rows against the base revision. Regenerate (drops fixed rows only):
//   READ_FAULT_BASELINE=write bun run test <this file>
import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { writeFileSync } from "node:fs";

import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baseline from "@/api/handlers/case-law/ingestion/adapters/read-fault-guard-baseline.json";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import {
  atFindokFixture,
  atRisFixture,
  czNsFixture,
  czNssFixture,
  czRegionalFixture,
  czUsFixture,
  euEcjFixture,
  huBhgyFixture,
  plCourtsFixture,
  plKioFixture,
  plKisFixture,
  plNcourtFixture,
  plNsaFixture,
  plSnFixture,
  plTkFixture,
  plUodoFixture,
  plUokikFixture,
  skCourtsFixture,
  skUsFixture,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import {
  buildWithFault,
  changedPaths,
  classifyFaultedBuild,
  flattenBuilt,
  READ_FAULTS,
  recordFetchStages,
} from "@/api/tests/helpers/read-fault-drivers";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

import { readPublisherText } from "./publisher-read";

/**
 * What drives each adapter's reads. Total over the adapter keys, so a source
 * registered without a fixture does not compile.
 */
const READ_FAULT_COVERAGE = {
  [ADAPTER_KEYS.CZ_NS]: czNsFixture,
  [ADAPTER_KEYS.CZ_NSS]: czNssFixture,
  [ADAPTER_KEYS.CZ_US]: czUsFixture,
  [ADAPTER_KEYS.CZ_REGIONAL]: czRegionalFixture,
  [ADAPTER_KEYS.SK_COURTS]: skCourtsFixture,
  [ADAPTER_KEYS.SK_US]: skUsFixture,
  [ADAPTER_KEYS.PL_COURTS]: plCourtsFixture,
  [ADAPTER_KEYS.PL_SN]: plSnFixture,
  [ADAPTER_KEYS.PL_KIO]: plKioFixture,
  [ADAPTER_KEYS.PL_TK]: plTkFixture,
  [ADAPTER_KEYS.PL_NSA]: plNsaFixture,
  [ADAPTER_KEYS.PL_NCOURT]: plNcourtFixture,
  [ADAPTER_KEYS.AT_COURTS]: () => atRisFixture(ADAPTER_KEYS.AT_COURTS),
  [ADAPTER_KEYS.AT_VFGH]: () => atRisFixture(ADAPTER_KEYS.AT_VFGH),
  [ADAPTER_KEYS.AT_VWGH]: () => atRisFixture(ADAPTER_KEYS.AT_VWGH),
  [ADAPTER_KEYS.AT_BVWG]: () => atRisFixture(ADAPTER_KEYS.AT_BVWG),
  [ADAPTER_KEYS.AT_LVWG]: () => atRisFixture(ADAPTER_KEYS.AT_LVWG),
  [ADAPTER_KEYS.AT_ASYLGH]: () => atRisFixture(ADAPTER_KEYS.AT_ASYLGH),
  [ADAPTER_KEYS.AT_UBAS]: () => atRisFixture(ADAPTER_KEYS.AT_UBAS),
  [ADAPTER_KEYS.AT_UVS]: () => atRisFixture(ADAPTER_KEYS.AT_UVS),
  [ADAPTER_KEYS.AT_VERG]: () => atRisFixture(ADAPTER_KEYS.AT_VERG),
  [ADAPTER_KEYS.AT_UMSE]: () => atRisFixture(ADAPTER_KEYS.AT_UMSE),
  [ADAPTER_KEYS.AT_BKS]: () => atRisFixture(ADAPTER_KEYS.AT_BKS),
  [ADAPTER_KEYS.AT_FINDOK]: atFindokFixture,
  [ADAPTER_KEYS.EU_ECJ]: euEcjFixture,
  [ADAPTER_KEYS.HU_BHGY]: huBhgyFixture,
  [ADAPTER_KEYS.PL_KIS]: plKisFixture,
  [ADAPTER_KEYS.PL_UODO]: plUodoFixture,
  [ADAPTER_KEYS.PL_UOKIK]: plUokikFixture,
} as const satisfies Record<AdapterKey, () => EnrolledAdapterFixture>;

const UNDRIVEN_REASON =
  "The enrolled fixture assembles the decision from served payloads; no publisher read is driven.";

const BASELINE_FILE = new URL(
  "read-fault-guard-baseline.json",
  import.meta.url,
);
const recorded: Readonly<Record<string, string>> = baseline.rows;
const writing = process.env["READ_FAULT_BASELINE"] === "write";
const observedRows = new Map<string, string>();

const originalFetch = globalThis.fetch;
beforeAll(() => {
  // Retry backoff and publisher pacing would only slow the faulted builds.
  spyOn(Bun, "sleep").mockImplementation(async () => {
    await Promise.resolve();
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  mock.restore();
  if (writing) {
    const rows = Object.fromEntries(
      [...observedRows.keys()]
        .toSorted()
        .map((key) => [key, recorded[key] ?? observedRows.get(key)]),
    );
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify({ comment: baseline.comment, rows }, null, 2)}\n`,
    );
  }
});

const coverage = new Map<string, () => EnrolledAdapterFixture>(
  Object.entries(READ_FAULT_COVERAGE),
);
const coverageFor = (key: string) =>
  coverage.get(key) ?? panic(`Missing read-fault fixture for ${key}`);

const rowsRecordedFor = (key: string) =>
  Object.keys(recorded)
    .filter((row) => row.startsWith(`${key}::`))
    .toSorted();

const observe = (row: string, reason: string) => {
  observedRows.set(row, reason);
  return row;
};

test("every registered adapter has a read-fault fixture", () => {
  expect(listAdapters().map(({ key }) => key)).toEqual(
    expect.arrayContaining(Object.keys(READ_FAULT_COVERAGE)),
  );
  expect(Object.keys(READ_FAULT_COVERAGE).toSorted()).toEqual(
    listAdapters()
      .map(({ key }) => key)
      .toSorted(),
  );
});

for (const adapter of listAdapters()) {
  test(`${adapter.key}: failed publisher reads never build a different decision`, async () => {
    const build = async () => await coverageFor(adapter.key)().buildDecision();
    const control = await recordFetchStages(build);
    const rows: string[] = [];
    if (control.stages.length === 0) {
      rows.push(observe(`${adapter.key}::undriven`, UNDRIVEN_REASON));
    } else {
      // Paths two unfaulted builds disagree on (timestamps) say nothing about a fault.
      const repeat = await recordFetchStages(build);
      const volatile = new Set(
        changedPaths(flattenBuilt(control.value), flattenBuilt(repeat.value)),
      );
      for (const stage of control.stages) {
        for (const fault of READ_FAULTS) {
          const outcome = classifyFaultedBuild({
            control: control.value,
            faulted: await buildWithFault({ stage, fault, build }),
            volatile,
          });
          if (outcome.type === "degraded") {
            rows.push(
              observe(
                `${adapter.key}::${stage}::${fault}`,
                `A failed read builds a different decision (${outcome.changed.slice(0, 3).join(", ")}); pending migration to readPublisher.`,
              ),
            );
          }
        }
      }
    }
    if (!writing) {
      expect(
        rows.toSorted(),
        "New rows fail: surface the failed read (ReadOutcome / readPublisher). Rows that no longer occur must be removed from the baseline.",
      ).toEqual(rowsRecordedFor(adapter.key));
    }
  }, 120_000);
}

test("a removed adapter cannot leave a stale row", () => {
  const keys = new Set<string>(listAdapters().map(({ key }) => key));
  for (const row of Object.keys(recorded)) {
    expect(keys.has(row.split("::").at(0) ?? "")).toBe(true);
  }
});

// ── Self-tests: the oracle must catch the class it guards ──

const PUBLISHER = "https://publisher.invalid/document/1";
const servedDocument = () => {
  globalThis.fetch = asFetchMock(
    async () => await Promise.resolve(new Response("<p>decision text</p>")),
  );
};

test("a helper mapping a failed read to an empty document is degraded", async () => {
  const build = async () => {
    servedDocument();
    const response = await fetch(PUBLISHER);
    return { fulltext: response.ok ? await response.text() : "" };
  };
  const control = await recordFetchStages(build);
  const [stage] = control.stages;
  expect(stage).toBe("GET publisher.invalid/document/{n}");
  const outcome = classifyFaultedBuild({
    control: control.value,
    faulted: await buildWithFault({
      stage: stage ?? panic("no stage"),
      fault: "status-500",
      build,
    }),
    volatile: new Set(),
  });
  expect(outcome).toEqual({ type: "degraded", changed: ["fulltext"] });
});

test("a catch that returns an empty list is degraded", async () => {
  const build = async () => {
    servedDocument();
    try {
      const response = await fetch(PUBLISHER);
      return { judges: [await response.text()] };
    } catch {
      return { judges: [] };
    }
  };
  const control = await recordFetchStages(build);
  const outcome = classifyFaultedBuild({
    control: control.value,
    faulted: await buildWithFault({
      stage: control.stages.at(0) ?? panic("no stage"),
      fault: "timeout",
      build,
    }),
    volatile: new Set(),
  });
  expect(outcome.type).toBe("degraded");
});

test("a read through readPublisherText surfaces every fault", async () => {
  const build = async () => {
    servedDocument();
    const outcome = await readPublisherText(PUBLISHER, {
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      fetchStage: "listing",
      timeoutMs: 1000,
    });
    return outcome.type === "present"
      ? { fulltext: outcome.value }
      : panic(`Publisher read ${outcome.type}`);
  };
  const control = await recordFetchStages(build);
  for (const fault of READ_FAULTS) {
    expect(
      classifyFaultedBuild({
        control: control.value,
        faulted: await buildWithFault({
          stage: control.stages.at(0) ?? panic("no stage"),
          fault,
          build,
        }),
        volatile: new Set(),
      }),
    ).toEqual({ type: "surfaced" });
  }
});

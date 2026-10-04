// Every registered adapter's publisher reads, driven with failures.
//
// Each adapter's enrolled fixture is built once as served, recording the
// fetch stages it reads, then once per stage × fault (500, timeout, empty 204,
// empty 200 body) with every request of that stage failing. A faulted build
// must fail, build exactly the control decision, or state the failure typed:
// a part marked unavailable while the main text reads as served, or the
// document marked unavailable on a listing-only decision. A part marker never
// excuses a failed main text, and a fault is never an absence. Otherwise a
// build that succeeds with different content stored a failed read as missing
// or empty fields.
//
// Refusals (401, 403) are a separate class: the build must state the refusal
// typed (a `refused` marker on the decision, a withheld part typed as refused
// or "secondary-refused" with the main text intact, or a typed refused
// failure). Failing untyped or building unchanged does not count; a typed
// marker is surfaced, not degraded.
//
// Rows in read-fault-guard-baseline.json are the current exceptions: an
// adapter whose fixture drives no publisher read (`<adapter>::undriven`), a
// stage × fault that degrades the decision, or a stage × refusal the build
// does not state typed. New rows fail; rows that no longer
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
import {
  isStoredReadAbsence,
  isStoredReadUnavailable,
  READ_OUTCOME_METADATA_KEY,
  storedReadUnavailable,
  UNAVAILABLE_CYCLES_BEFORE_MARKING,
  type ReadOutcome,
  type ReadRefusal,
  type ReadUnavailableCause,
} from "@/api/lib/errors/read-outcome";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import { OBSERVATION_DETAIL } from "@/api/lib/legal-search/partial-observation-sql";
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
  classifyRefusedBuild,
  flattenBuilt,
  READ_FAULTS,
  READ_REFUSALS,
  recordFetchStages,
  type FaultOutcome,
  type RefusalOutcome,
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

const refusalDetail = (
  outcome: Extract<RefusalOutcome, { type: "untyped" }>,
): string => {
  switch (outcome.how) {
    case "failed":
      return "the build fails without a typed refusal";
    case "unchanged":
      return "the build stores the decision unchanged";
    case "changed":
      return `the build stores a different decision: ${outcome.changed.slice(0, 3).join(", ")}`;
    case "main-text-failed":
      return `a part refusal hides a failed main text: ${outcome.changed.slice(0, 3).join(", ")}`;
    default:
      outcome.how satisfies never;
      return panic(`Unhandled refusal outcome: ${String(outcome.how)}`);
  }
};

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
        for (const fault of READ_REFUSALS) {
          const outcome = classifyRefusedBuild({
            control: control.value,
            faulted: await buildWithFault({ stage, fault, build }),
            fault,
            volatile,
          });
          if (outcome.type === "untyped") {
            rows.push(
              observe(
                `${adapter.key}::${stage}::${fault}`,
                `A refused read is not stated as a typed refusal (${refusalDetail(outcome)}); pending migration to readPublisher's refused outcome.`,
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

// ── Self-tests: refusals must be stated typed ──

const NOTICE = "https://publisher.invalid/notice/1";
const servedDocumentAndNotice = () => {
  globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
    const href = input instanceof Request ? input.url : String(input);
    return await Promise.resolve(
      new Response(href === NOTICE ? "<notice/>" : "<p>decision text</p>"),
    );
  });
};
const readInit = {
  adapterKey: ADAPTER_KEYS.CZ_NSS,
  fetchStage: "listing",
  timeoutMs: 1000,
} as const;

const refusalOutcomes = async (
  build: () => Promise<unknown>,
  stageIndex = 0,
): Promise<RefusalOutcome[]> => {
  const control = await recordFetchStages(build);
  const stage = control.stages.at(stageIndex) ?? panic("no stage");
  const outcomes: RefusalOutcome[] = [];
  for (const fault of READ_REFUSALS) {
    outcomes.push(
      classifyRefusedBuild({
        control: control.value,
        faulted: await buildWithFault({ stage, fault, build }),
        fault,
        volatile: new Set(),
      }),
    );
  }
  return outcomes;
};

test("a helper mapping a 403 to an empty document is not a typed refusal", async () => {
  const outcomes = await refusalOutcomes(async () => {
    servedDocument();
    const response = await fetch(PUBLISHER);
    return { fulltext: response.ok ? await response.text() : "" };
  });
  expect(outcomes).toEqual(
    READ_REFUSALS.map(() => ({
      type: "untyped",
      how: "changed",
      changed: ["fulltext"],
    })),
  );
});

test("a helper failing on a refusal without typing it is not a typed refusal", async () => {
  const outcomes = await refusalOutcomes(async () => {
    servedDocument();
    const outcome = await readPublisherText(PUBLISHER, readInit);
    return outcome.type === "present"
      ? { fulltext: outcome.value }
      : panic(`Publisher read ${outcome.type}`);
  });
  expect(outcomes).toEqual(
    READ_REFUSALS.map(() => ({ type: "untyped", how: "failed", changed: [] })),
  );
});

test("a decision storing the typed refused marker surfaces the refusal", async () => {
  const outcomes = await refusalOutcomes(async () => {
    servedDocument();
    const outcome = await readPublisherText(PUBLISHER, readInit);
    switch (outcome.type) {
      case "present":
        return { fulltext: outcome.value };
      case "refused":
        return { fulltextRefusal: outcome };
      case "absent":
      case "unavailable":
        return panic(`Publisher read ${outcome.type}`);
      default:
        outcome satisfies never;
        return panic(`Unhandled read outcome: ${String(outcome)}`);
    }
  });
  expect(outcomes).toEqual(READ_REFUSALS.map(() => ({ type: "surfaced" })));
});

test("a withheld part typed as refused (scope part or secondary-refused) is surfaced", async () => {
  const buildWith =
    (mark: (refusal: ReadRefusal) => Record<string, unknown>) => async () => {
      servedDocumentAndNotice();
      const document = await readPublisherText(PUBLISHER, readInit);
      const notice = await readPublisherText(NOTICE, {
        ...readInit,
        refusalScope: "part",
      });
      const fulltext =
        document.type === "present" ? document.value : panic("no document");
      switch (notice.type) {
        case "present":
          return { fulltext, notice: notice.value };
        case "refused":
          return { fulltext, ...mark(notice) };
        case "absent":
        case "unavailable":
          return panic(`Notice read ${notice.type}`);
        default:
          notice satisfies never;
          return panic(`Unhandled read outcome: ${String(notice)}`);
      }
    };
  for (const build of [
    buildWith((refusal) => ({ parts: { notice: refusal } })),
    buildWith(() => ({
      observationDetail: OBSERVATION_DETAIL.SECONDARY_REFUSED,
    })),
  ]) {
    expect(await refusalOutcomes(build, 1)).toEqual(
      READ_REFUSALS.map(() => ({ type: "surfaced" })),
    );
  }
});

test("a source-level refusal stop is a typed refusal", async () => {
  const outcomes = await refusalOutcomes(async () => {
    servedDocument();
    const outcome = await readPublisherText(PUBLISHER, {
      ...readInit,
      refusalMode: "stop-refusal",
    });
    return outcome.type === "present"
      ? { fulltext: outcome.value }
      : panic(`Publisher read ${outcome.type}`);
  });
  expect(outcomes).toEqual(READ_REFUSALS.map(() => ({ type: "surfaced" })));
});

// ── Self-tests: typed unavailable outcomes ──

const faultOutcomes = async (
  build: () => Promise<unknown>,
  stageIndex: number,
  requireFailure = false,
): Promise<FaultOutcome[]> => {
  const control = await recordFetchStages(build);
  const stage = control.stages.at(stageIndex) ?? panic("no stage");
  const outcomes: FaultOutcome[] = [];
  for (const fault of READ_FAULTS) {
    outcomes.push(
      classifyFaultedBuild({
        control: control.value,
        faulted: await buildWithFault({ stage, fault, build }),
        volatile: new Set(),
        requireFailure,
      }),
    );
  }
  return outcomes;
};

/** The cause a non-present read carries, for a stored marker. */
const unreadCause = (outcome: ReadOutcome<string>): ReadUnavailableCause =>
  outcome.type === "unavailable" ? outcome.cause : panic(outcome.type);

const withPartMarker = async () => {
  servedDocumentAndNotice();
  const document = await readPublisherText(PUBLISHER, readInit);
  const notice = await readPublisherText(NOTICE, readInit);
  const fulltext =
    document.type === "present" ? document.value : panic("no document");
  return notice.type === "present"
    ? { fulltext, notice: notice.value }
    : {
        fulltext,
        metadata: {
          [READ_OUTCOME_METADATA_KEY]: storedReadUnavailable({
            cause: unreadCause(notice),
            scope: "part",
            consecutiveCycles: 1,
          }),
        },
      };
};

test("a part marked unavailable while the main text reads as served is surfaced", async () => {
  expect(await faultOutcomes(withPartMarker, 1)).toEqual(
    READ_FAULTS.map(() => ({ type: "surfaced" })),
  );
});

test("a part marker on a decision whose main text failed is degraded", async () => {
  const build = async () => {
    servedDocument();
    const document = await readPublisherText(PUBLISHER, readInit);
    return document.type === "present"
      ? { fulltext: document.value }
      : {
          fulltext: "",
          metadata: {
            [READ_OUTCOME_METADATA_KEY]: storedReadUnavailable({
              cause: unreadCause(document),
              scope: "part",
              consecutiveCycles: 1,
            }),
          },
        };
  };
  for (const outcome of await faultOutcomes(build, 0)) {
    expect(outcome.type).toBe("degraded");
  }
  const refused = await refusalOutcomes(async () => {
    servedDocument();
    const document = await readPublisherText(PUBLISHER, {
      ...readInit,
      refusalScope: "part",
    });
    return document.type === "present"
      ? { fulltext: document.value }
      : { fulltext: "", metadata: { [READ_OUTCOME_METADATA_KEY]: document } };
  });
  for (const outcome of refused) {
    expect(outcome).toMatchObject({ type: "untyped", how: "main-text-failed" });
  }
});

const listingOnlyWith =
  (reason: (outcome: ReadOutcome<string>) => unknown, listingOnly = true) =>
  async () => {
    servedDocument();
    const document = await readPublisherText(PUBLISHER, readInit);
    return document.type === "present"
      ? { caseNumber: "1", fulltext: document.value }
      : {
          caseNumber: "1",
          ...(listingOnly ? { isListingOnly: true } : {}),
          metadata: { [READ_OUTCOME_METADATA_KEY]: reason(document) },
        };
  };

const documentUnavailable = (outcome: ReadOutcome<string>) =>
  storedReadUnavailable({
    cause: unreadCause(outcome),
    scope: "document",
    consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
  });

test("the document marked unavailable on a listing-only decision is surfaced, and only there", async () => {
  expect(await faultOutcomes(listingOnlyWith(documentUnavailable), 0)).toEqual(
    READ_FAULTS.map(() => ({ type: "surfaced" })),
  );
  for (const outcome of await faultOutcomes(
    listingOnlyWith(documentUnavailable, false),
    0,
  )) {
    expect(outcome.type).toBe("degraded");
  }
});

test("a fault stored as a stated absence is degraded", async () => {
  const absence = () => ({
    type: "absent",
    evidence: "publisher-typed-absence",
  });
  for (const outcome of await faultOutcomes(listingOnlyWith(absence), 0)) {
    expect(outcome.type).toBe("degraded");
  }
});

test("an adapter that must fail on faults passes only by failing", async () => {
  for (const outcome of await faultOutcomes(
    listingOnlyWith(documentUnavailable),
    0,
    true,
  )) {
    expect(outcome.type).toBe("degraded");
  }
  const failing = async () => {
    servedDocument();
    const document = await readPublisherText(PUBLISHER, readInit);
    return document.type === "present"
      ? { fulltext: document.value }
      : panic(`Publisher read ${document.type}`);
  };
  expect(await faultOutcomes(failing, 0, true)).toEqual(
    READ_FAULTS.map(() => ({ type: "surfaced" })),
  );
});

test("stored outcome markers are recognised only in their typed shape", () => {
  const marker = storedReadUnavailable({
    cause: { kind: "thrown", error: new Error("timed out") },
    scope: "part",
    consecutiveCycles: 2,
  });
  expect(marker).toEqual({
    type: "unavailable",
    scope: "part",
    cause: { kind: "thrown" },
    consecutiveCycles: 2,
  });
  expect(isStoredReadUnavailable(marker)).toBe(true);
  for (const value of [
    { ...marker, consecutiveCycles: 0 },
    { ...marker, scope: "source" },
    { ...marker, cause: { kind: "guessed" } },
    { type: "unavailable", cause: { kind: "status", status: 500 } },
  ]) {
    expect(isStoredReadUnavailable(value)).toBe(false);
  }
  expect(
    isStoredReadAbsence({
      type: "absent",
      evidence: "publisher-typed-absence",
    }),
  ).toBe(true);
  expect(isStoredReadAbsence({ type: "absent", evidence: "empty-body" })).toBe(
    false,
  );
});

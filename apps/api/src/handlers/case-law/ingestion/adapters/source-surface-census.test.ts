/**
 * Surface conformance: which of a publisher's pages an adapter records.
 *
 * The field inventory asks what a stored page states and whether the row
 * carries it. It cannot ask the question before that one — whether the page is
 * fetched at all — because a page nobody fetches is a page nobody lists, and a
 * source that serves a decision across ten addresses looks complete to an
 * inventory that reads two of them.
 *
 * So every adapter declares a census of the surfaces its publisher serves for
 * one decision, and each is recorded, excluded with a reason, or on the
 * backlog with a reason and a line in `source-surface-backlog-baseline.json`.
 * The invariants below:
 *
 * 1. A surface key reads the same way everywhere, and two surfaces of one
 *    adapter never claim the same envelope part.
 * 2. A backlog surface names the adapter declaring it, and the baseline and
 *    the declarations agree in both directions, so the set only shrinks.
 * 3. Every adapter allowed to declare a backlog surface uses that permission,
 *    so the closed union cannot carry an escape nobody needs.
 * 4. A recorded surface is recorded in evidence: its part is in an envelope
 *    this repository can read back, either from a decision an adapter builds
 *    or from a committed page recording, read through `LEGACY_RAW_SHAPES`
 *    where the rows predate the envelope. An adapter with no such capture
 *    cannot declare a surface recorded — which is what makes "recorded" a
 *    statement about the stored row rather than about the fetch.
 */

import { panic } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import {
  backlogSurface,
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  LegacyRawShape,
  SourceSurfaceDisposition,
} from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import baseline from "@/api/handlers/case-law/ingestion/adapters/source-surface-backlog-baseline.json";
import { readGzipJson } from "@/api/lib/gzip-json";
import {
  LEGACY_BACKLOG_ADAPTERS,
  LEGACY_RAW_SHAPES,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";
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
  plCourtsSearchFixture,
  plKioFixture,
  plNsaFixture,
  plNcourtFixture,
  plSnFixture,
  plTkFixture,
  skCourtsFixture,
  skUsFixture,
  type AtRisFixtureAdapter,
  type EnrolledAdapterFixture,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Where an envelope can be read back from ──────────────

/**
 * What this suite can read one adapter's stored envelope from.
 *
 * `built` runs the adapter's own builder over payloads shaped like its
 * publisher's; `page-recording` reads a committed recording of a crawl page,
 * which is how an adapter that predates the envelope states what it stores;
 * `shared-path` points at another adapter's evidence where the two run the
 * same code; `none` is an adapter no capture states anything about, and it is
 * a failure for any surface it declares recorded.
 */
type SurfaceEvidence =
  | { readonly kind: "built"; readonly fixture: () => EnrolledAdapterFixture }
  | { readonly kind: "page-recording"; readonly file: string }
  | { readonly kind: "shared-path"; readonly with: AdapterKey }
  | { readonly kind: "none"; readonly reason: string };

/**
 * The eleven tribunal adapters share every code path but the application
 * named in the query, and each states a branch of its own, so each is driven
 * through that path with its own application's payloads.
 */
const atRisEvidence = (
  adapter: AtRisFixtureAdapter,
): readonly SurfaceEvidence[] => [
  { kind: "built", fixture: () => atRisFixture(adapter) },
];

const SURFACE_EVIDENCE = {
  [ADAPTER_KEYS.CZ_NS]: [
    { kind: "built", fixture: czNsFixture },
    { kind: "page-recording", file: "cz-ns-page.json.gz" },
  ],
  [ADAPTER_KEYS.CZ_NSS]: [{ kind: "built", fixture: czNssFixture }],
  [ADAPTER_KEYS.CZ_US]: [
    { kind: "built", fixture: czUsFixture },
    { kind: "page-recording", file: "cz-us-page.json.gz" },
  ],
  [ADAPTER_KEYS.CZ_REGIONAL]: [{ kind: "built", fixture: czRegionalFixture }],
  [ADAPTER_KEYS.SK_COURTS]: [
    { kind: "built", fixture: skCourtsFixture },
    { kind: "page-recording", file: "sk-courts-page.json.gz" },
  ],
  [ADAPTER_KEYS.SK_US]: [{ kind: "built", fixture: skUsFixture }],
  [ADAPTER_KEYS.PL_COURTS]: [
    { kind: "built", fixture: plCourtsFixture },
    // The second listing is a second decision: a row is named by the dump or
    // by the date-filtered search, so no one envelope holds both parts.
    { kind: "built", fixture: plCourtsSearchFixture },
    { kind: "page-recording", file: "pl-courts-page.json.gz" },
  ],
  [ADAPTER_KEYS.PL_SN]: [
    { kind: "built", fixture: plSnFixture },
    { kind: "page-recording", file: "pl-sn-page.json.gz" },
  ],
  [ADAPTER_KEYS.PL_TK]: [{ kind: "built", fixture: plTkFixture }],
  [ADAPTER_KEYS.PL_NSA]: [{ kind: "built", fixture: plNsaFixture }],
  [ADAPTER_KEYS.PL_NCOURT]: [{ kind: "built", fixture: plNcourtFixture }],
  [ADAPTER_KEYS.AT_COURTS]: [
    ...atRisEvidence(ADAPTER_KEYS.AT_COURTS),
    { kind: "page-recording", file: "at-courts-page.json.gz" },
  ],
  [ADAPTER_KEYS.AT_VFGH]: atRisEvidence(ADAPTER_KEYS.AT_VFGH),
  [ADAPTER_KEYS.AT_VWGH]: atRisEvidence(ADAPTER_KEYS.AT_VWGH),
  [ADAPTER_KEYS.AT_BVWG]: atRisEvidence(ADAPTER_KEYS.AT_BVWG),
  [ADAPTER_KEYS.AT_LVWG]: atRisEvidence(ADAPTER_KEYS.AT_LVWG),
  [ADAPTER_KEYS.AT_ASYLGH]: atRisEvidence(ADAPTER_KEYS.AT_ASYLGH),
  [ADAPTER_KEYS.AT_UBAS]: atRisEvidence(ADAPTER_KEYS.AT_UBAS),
  [ADAPTER_KEYS.AT_UVS]: atRisEvidence(ADAPTER_KEYS.AT_UVS),
  [ADAPTER_KEYS.AT_VERG]: atRisEvidence(ADAPTER_KEYS.AT_VERG),
  [ADAPTER_KEYS.AT_UMSE]: atRisEvidence(ADAPTER_KEYS.AT_UMSE),
  [ADAPTER_KEYS.AT_BKS]: atRisEvidence(ADAPTER_KEYS.AT_BKS),
  [ADAPTER_KEYS.AT_FINDOK]: [{ kind: "built", fixture: atFindokFixture }],
  [ADAPTER_KEYS.EU_ECJ]: [{ kind: "built", fixture: euEcjFixture }],
  [ADAPTER_KEYS.HU_BHGY]: [{ kind: "built", fixture: huBhgyFixture }],
  [ADAPTER_KEYS.PL_KIO]: [{ kind: "built", fixture: plKioFixture }],
} as const satisfies Record<AdapterKey, readonly SurfaceEvidence[]>;

// ── Reading a stored raw back into part names ────────────

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const LEGACY_SHAPES_BY_ADAPTER = new Map<string, readonly LegacyRawShape[]>(
  Object.entries(LEGACY_RAW_SHAPES),
);

/** The part names one legacy payload stands for, under one declared shape. */
const legacyPartNames = (
  shape: LegacyRawShape,
  raw: string,
): readonly string[] => {
  if (shape.shape !== "wrapper-json") {
    return [shape.part];
  }
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed)
    ? Object.entries(shape.keys).flatMap(([wrapperKey, part]) =>
        parsed[wrapperKey] === undefined || parsed[wrapperKey] === null
          ? []
          : [part],
      )
    : [];
};

/**
 * What one stored row states it holds: the envelope's own names, or the names
 * its adapter's legacy shape maps the payload onto.
 *
 * An envelope names two kinds of surface. A text part it holds, and a binary
 * part it points at: the bytes of a publisher's file live in corpus storage
 * and the envelope carries the address. Both are a surface this row records,
 * so both count as evidence.
 */
const storedNamesOf = (
  adapter: AdapterKey,
  raw: string,
  contentType: string | null,
): readonly string[] => {
  const parts = decodeSourceRawEnvelope(raw);
  if (parts !== null) {
    return [
      ...Object.keys(parts),
      ...Object.keys(decodeSourceRawEnvelopeObjects(raw)),
    ];
  }
  return (LEGACY_SHAPES_BY_ADAPTER.get(adapter) ?? [])
    .filter((shape) => shape.contentTypes.includes(contentType))
    .flatMap((shape) => legacyPartNames(shape, raw));
};

/** Every decision of a committed page recording, as the crawl stored it. */
const pageRecordingNames = async (
  adapter: AdapterKey,
  file: string,
): Promise<readonly string[]> => {
  const recording: unknown = await readGzipJson(new URL(file, FIXTURES_DIR));
  const page = isRecord(recording) ? recording["page"] : undefined;
  const decisions = isRecord(page) ? page["decisions"] : undefined;
  if (!Array.isArray(decisions)) {
    return panic(`${file} holds no recorded page of decisions`);
  }
  const names = new Set<string>();
  for (const decision of decisions) {
    if (!isRecord(decision) || typeof decision["sourceRaw"] !== "string") {
      continue;
    }
    const contentType = decision["sourceRawContentType"];
    for (const name of storedNamesOf(
      adapter,
      decision["sourceRaw"],
      typeof contentType === "string" ? contentType : null,
    )) {
      names.add(name);
    }
  }
  return [...names];
};

const evidenceNames = async (
  adapter: AdapterKey,
): Promise<readonly string[]> => {
  const names = new Set<string>();
  const add = (found: readonly string[]) => {
    for (const name of found) {
      names.add(name);
    }
  };
  for (const evidence of SURFACE_EVIDENCE[adapter]) {
    switch (evidence.kind) {
      case "built": {
        const decision = await evidence.fixture().buildDecision();
        add(
          storedNamesOf(
            adapter,
            decision.sourceRaw ?? "",
            decision.sourceRawContentType ?? null,
          ),
        );
        break;
      }
      case "page-recording":
        add(await pageRecordingNames(adapter, evidence.file));
        break;
      case "shared-path":
        add(await evidenceNames(evidence.with));
        break;
      case "none":
        break;
      default:
        evidence satisfies never;
        panic(`Unhandled surface evidence: ${JSON.stringify(evidence)}`);
    }
  }
  return [...names];
};

// ── The declarations ─────────────────────────────────────

const DECLARED_ADAPTER_KEYS = Object.values(ADAPTER_KEYS);

const BACKLOG_BASELINE: Readonly<Record<string, readonly string[]>> =
  baseline.backlog;

const adapterFor = (key: AdapterKey) =>
  getAdapter(key) ?? panic(`${key} is declared but not registered`);

const surfacesOf = (
  key: AdapterKey,
): readonly (readonly [string, SourceSurfaceDisposition])[] =>
  Object.entries(adapterFor(key).sourceSurfaces.surfaces);

const SURFACE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// ── Invariants ───────────────────────────────────────────

describe("every adapter accounts for the surfaces its publisher serves", () => {
  test.each(DECLARED_ADAPTER_KEYS)(
    "%s: its census is spelled one way and claims each part once",
    (key) => {
      const surfaces = surfacesOf(key);
      expect(
        surfaces.length,
        `${key}: its census states no surface at all, so nothing was decided about its publisher's pages.`,
      ).toBeGreaterThan(0);

      const misspelled = surfaces
        .map(([surface]) => surface)
        .filter((surface) => !SURFACE_KEY_PATTERN.test(surface));
      expect(
        misspelled,
        `${key}: these surface keys are not kebab-case: ${misspelled.join(", ")}. One spelling, or a baseline line cannot be matched to a declaration.`,
      ).toEqual([]);

      const parts = surfaces.flatMap(([, disposition]) =>
        disposition.disposition === "stored" ? [disposition.part] : [],
      );
      const duplicated = parts.filter(
        (part, index) => parts.indexOf(part) !== index,
      );
      expect(
        duplicated,
        `${key}: two surfaces are recorded under the same part: ${duplicated.join(", ")}. One would overwrite the other in the envelope.`,
      ).toEqual([]);
    },
  );

  test("a backlog surface is declared by the adapter it names", () => {
    const misattributed = DECLARED_ADAPTER_KEYS.flatMap((key) =>
      surfacesOf(key).flatMap(([surface, disposition]) =>
        disposition.disposition === "backlog" && disposition.adapter !== key
          ? [`${key}/${surface} is filed under ${disposition.adapter}`]
          : [],
      ),
    );

    expect(
      misattributed,
      `these backlog surfaces name another adapter, so their baseline lines are not the ones that would be deleted: ${misattributed.join("; ")}.`,
    ).toEqual([]);
  });

  test("the backlog baseline names exactly the surfaces nothing records yet", () => {
    const declared = DECLARED_ADAPTER_KEYS.flatMap((key) =>
      surfacesOf(key).flatMap(([surface, disposition]) =>
        disposition.disposition === "backlog" ? [`${key}/${surface}`] : [],
      ),
    ).toSorted();
    const listed = Object.entries(BACKLOG_BASELINE)
      .flatMap(([key, surfaces]) =>
        surfaces.map((surface) => `${key}/${surface}`),
      )
      .toSorted();

    // A ratchet only tightens: recording a surface deletes its line, and a
    // surface left unrecorded has to be written into the baseline in the same
    // change rather than passing as a decision nobody stated.
    const recordedButListed = listed.filter(
      (entry) => !declared.includes(entry),
    );
    const backlogButUnlisted = declared.filter(
      (entry) => !listed.includes(entry),
    );
    expect(
      recordedButListed,
      `source-surface-backlog-baseline.json still lists surfaces no adapter declares on the backlog: ${recordedButListed.join(", ")}. Delete those lines.`,
    ).toEqual([]);
    expect(
      backlogButUnlisted,
      `these surfaces are declared on the backlog without a line in source-surface-backlog-baseline.json: ${backlogButUnlisted.join(", ")}. Record them, or add them to the baseline in this change.`,
    ).toEqual([]);
  });

  test("every adapter allowed a backlog surface still needs one", () => {
    const unused = LEGACY_BACKLOG_ADAPTERS.filter(
      (key) => (BACKLOG_BASELINE[key] ?? []).length === 0,
    );

    expect(
      unused,
      `these adapters may declare a backlog surface and declare none: ${unused.join(", ")}. Drop them from LEGACY_BACKLOG_ADAPTERS, or the union carries an escape nothing needs.`,
    ).toEqual([]);
  });

  test.each(DECLARED_ADAPTER_KEYS)(
    "%s: every surface it records is in an envelope that can be read back",
    async (key) => {
      const recorded = surfacesOf(key).flatMap(([surface, disposition]) =>
        disposition.disposition === "stored"
          ? [{ surface, ...disposition }]
          : [],
      );
      if (recorded.length === 0) {
        return;
      }

      const names = await evidenceNames(key);
      const missing = recorded.flatMap(({ surface, part }) =>
        names.includes(part) ? [] : [`${surface} -> part ${part}`],
      );

      expect(
        missing,
        `${key}: these surfaces are declared recorded and no envelope this repository can read holds their part: ${missing.join("; ")}. Either the adapter does not store them, or the capture that would state it is missing.`,
      ).toEqual([]);
    },
  );
});

/** A census with one surface named and one left out, for the checks below. */
const censusOfTwo = (
  surfaces: Record<"listing" | "detail", SourceSurfaceDisposition>,
): Record<string, SourceSurfaceDisposition> => surfaces;

/**
 * What the census type refuses outright. Each directive below is the
 * assertion: delete it and the build fails, which is what makes these rules
 * something a reviewer never has to remember.
 */
describe("the census type refuses what the ratchet forbids", () => {
  test("a source registered tomorrow cannot put a surface on the backlog", () => {
    // @ts-expect-error only the adapters on the committed baseline may be named
    const surface = backlogSurface("zz-new-court", "a source added today");

    expect(surface.disposition).toBe("backlog");
  });

  test("an adapter that records everything it fetches cannot open a backlog", () => {
    // @ts-expect-error cz-us left the union when its last surface was recorded
    const surface = backlogSurface(ADAPTER_KEYS.CZ_US, "a page it keeps");

    expect(surface.disposition).toBe("backlog");
  });

  test("a surface the census names needs a disposition", () => {
    // @ts-expect-error `detail` is named and left undecided
    const surfaces = censusOfTwo({ listing: storedSourceSurface("listing") });

    expect(Object.keys(surfaces)).toEqual(["listing"]);
  });

  test("a backlog reason cannot be blank", () => {
    // @ts-expect-error a reason with no words in it is the silence this forbids
    const surface = backlogSurface(ADAPTER_KEYS.CZ_NS, "   ");

    expect(surface.reason.trim()).toBe("");
  });
});

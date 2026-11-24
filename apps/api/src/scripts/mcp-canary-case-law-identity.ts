/**
 * The deployed corpus holds to exact identity: a decision search finds,
 * resolved by its docket or its ECLI, is that decision. Sampled per court from
 * the live corpus, so a court whose identity model asks for parts its source
 * never publishes fails here rather than in a reader's hands.
 */
import { panic } from "better-result";
import * as v from "valibot";

import {
  isPrintedCourtJurisdiction,
  readPrintedCourt,
} from "@stll/api-contract/court-identity";
import {
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_SURFACE_OPEN,
} from "@stll/api-contract/public-country-capability";
import { mapWithConcurrency } from "@stll/concurrency";
import { sleep } from "@stll/concurrency/sleep";

/** The jurisdictions whose courts the probe samples. */
const CASE_LAW_IDENTITY_PROBE_COUNTRIES = ["CZE", "SVK", "AUT"] as const;

type ProbeCountry = (typeof CASE_LAW_IDENTITY_PROBE_COUNTRIES)[number];

/**
 * The query whose court facets name the courts sampled: the apex court's own
 * name, so no language is assumed. Each court is then sampled by the same
 * query, so every court a facet names has a decision to sample.
 */
const FACET_SEED_QUERY = {
  AUT: "Oberster Gerichtshof",
  CZE: "Nejvyšší soud",
  SVK: "Najvyšší súd",
} as const satisfies Record<ProbeCountry, string>;

const TOOL_CALL_CONCURRENCY = 4;
const FAILURES_REPORTED_MAX = 5;
/** How many times one search follows its continuation before giving up. */
const SEARCH_CONTINUATIONS_MAX = 10;
/** The longest a follow-up waits, whatever retryAfterMs asks. */
const SEARCH_CONTINUATION_WAIT_MAX_MS = 5000;

type CaseLawToolOutcome =
  { type: "ok"; payload: unknown } | { type: "error"; detail: string };

/** One MCP tool call against the deployment, its JSON payload parsed. */
export type CallCaseLawTool = (
  name: "resolve_case_law_decision" | "search_case_law",
  args: Record<string, unknown>,
) => Promise<CaseLawToolOutcome>;

/** How the probe waits before following a running search. */
type WaitFor = (milliseconds: number) => Promise<void>;

type CaseLawIdentityProbeOutcome =
  | { status: "passed"; detail: string }
  | { status: "failed"; detail: string }
  | { status: "not_applicable"; detail: string };

const searchHitSchema = v.object({
  caseNumber: v.string(),
  court: v.string(),
  decisionId: v.string(),
  ecli: v.nullish(v.string()),
});

const searchPayloadSchema = v.object({
  facets: v.nullish(
    v.object({
      court: v.array(
        v.object({ courts: v.array(v.object({ value: v.string() })) }),
      ),
    }),
  ),
  results: v.array(searchHitSchema),
});

/** A search the deployment is still running: follow it, it is not an answer. */
const runningSearchSchema = v.object({
  status: v.literal("running"),
  continuationToken: v.string(),
  retryAfterMs: v.number(),
});

const resolvePayloadSchema = v.variant("status", [
  v.object({
    status: v.literal("resolved"),
    document: v.object({ decisionId: v.string() }),
  }),
  v.object({
    status: v.literal("ambiguous"),
    candidates: v.array(v.object({ decisionId: v.string() })),
  }),
  v.object({
    status: v.picklist([
      "country_unavailable",
      "incomplete_identifier",
      "not_found",
    ]),
  }),
]);

type SearchHit = v.InferOutput<typeof searchHitSchema>;

/** How an identifier of the sampled decision must resolve. */
type IdentityExpectation = {
  identifier: string;
  /**
   * A docket names a case file, which can hold several decisions: a list of
   * candidates that includes the decision answers it. An ECLI names one.
   */
  candidatesAnswer: boolean;
};

const expectationsOf = ({ caseNumber, ecli }: SearchHit) => [
  { identifier: caseNumber, candidatesAnswer: true },
  ...(ecli === null || ecli === undefined
    ? []
    : [
        { identifier: ecli, candidatesAnswer: false },
        // An ECLI's letter case is typography (`Pl.US`, `PL.US`).
        { identifier: ecli.toUpperCase(), candidatesAnswer: false },
      ]),
];

/** Null when the identifier resolves to the decision, else why not. */
const resolutionFailure = async (
  callTool: CallCaseLawTool,
  { country, hit }: { country: ProbeCountry; hit: SearchHit },
  { candidatesAnswer, identifier }: IdentityExpectation,
): Promise<string | null> => {
  const outcome = await callTool("resolve_case_law_decision", {
    country,
    identifier,
  });
  const label = `${hit.court}: ${identifier}`;
  if (outcome.type === "error") {
    return `${label} -> ${outcome.detail}`;
  }
  const parsed = v.safeParse(resolvePayloadSchema, outcome.payload);
  if (!parsed.success) {
    return `${label} -> unreadable resolve payload`;
  }
  const resolution = parsed.output;
  switch (resolution.status) {
    case "resolved":
      return resolution.document.decisionId === hit.decisionId
        ? null
        : `${label} -> resolved another decision`;
    case "ambiguous":
      return candidatesAnswer &&
        resolution.candidates.some(
          ({ decisionId }) => decisionId === hit.decisionId,
        )
        ? null
        : `${label} -> ambiguous without it`;
    case "country_unavailable":
    case "incomplete_identifier":
    case "not_found":
      return `${label} -> ${resolution.status}`;
    default: {
      resolution satisfies never;
      return panic(`Unhandled resolution: ${String(resolution)}`);
    }
  }
};

const searchOf = async (
  callTool: CallCaseLawTool,
  wait: WaitFor,
  args: Record<string, unknown>,
): Promise<v.InferOutput<typeof searchPayloadSchema> | string> => {
  let callArgs = args;
  for (let attempt = 0; attempt <= SEARCH_CONTINUATIONS_MAX; attempt++) {
    const outcome = await callTool("search_case_law", callArgs);
    if (outcome.type === "error") {
      return outcome.detail;
    }
    const running = v.safeParse(runningSearchSchema, outcome.payload);
    if (!running.success) {
      const parsed = v.safeParse(searchPayloadSchema, outcome.payload);
      return parsed.success ? parsed.output : "unreadable search payload";
    }
    if (attempt === SEARCH_CONTINUATIONS_MAX) {
      // No follow-up comes after the last one, so its wait is not spent.
      break;
    }
    // The same arguments plus the token collect the work already running.
    callArgs = {
      ...args,
      continuation_token: running.output.continuationToken,
    };
    await wait(
      Math.min(
        Math.max(0, running.output.retryAfterMs),
        SEARCH_CONTINUATION_WAIT_MAX_MS,
      ),
    );
  }
  return `search still running after ${String(SEARCH_CONTINUATIONS_MAX)} continuations`;
};

/**
 * Whether a sampled decision's court is the court its facet named. Facets
 * name courts as stored, so one directory court can appear under several
 * spellings; where the directory reads printed names, both are compared by
 * the court they read to.
 */
const isSameCourt = (
  country: ProbeCountry,
  sampled: string,
  named: string,
): boolean => {
  if (sampled === named) {
    return true;
  }
  if (!isPrintedCourtJurisdiction(country)) {
    return false;
  }
  const sampledCourt = readPrintedCourt(country, sampled);
  const namedCourt = readPrintedCourt(country, named);
  return (
    sampledCourt.type === "court" &&
    namedCourt.type === "court" &&
    sampledCourt.court.id === namedCourt.court.id
  );
};

const SEARCH_CLOSED: CaseLawIdentityProbeOutcome = {
  status: "not_applicable",
  detail: "case-law search is not open, so no sample to resolve",
};

const probeCountry = async (
  callTool: CallCaseLawTool,
  wait: WaitFor,
  country: ProbeCountry,
): Promise<CaseLawIdentityProbeOutcome> => {
  // Facets are opt-in: a search that does not name them returns none.
  const seeded = await searchOf(callTool, wait, {
    country,
    facets: ["court"],
    limit: 1,
    queries: [FACET_SEED_QUERY[country]],
  });
  if (typeof seeded === "string") {
    return { status: "failed", detail: `court facets: ${seeded}` };
  }
  const courtFacets = seeded.facets?.court;
  if (courtFacets === undefined) {
    return { status: "failed", detail: "search returned no facets" };
  }
  const courts = [
    ...new Set(
      courtFacets.flatMap(({ courts: tier }) => tier.map(({ value }) => value)),
    ),
  ];
  if (courts.length === 0) {
    return { status: "failed", detail: "search returned no court facets" };
  }
  const samples = await mapWithConcurrency({
    items: courts,
    limit: TOOL_CALL_CONCURRENCY,
    operation: async (court) => ({
      court,
      sample: await searchOf(callTool, wait, {
        country,
        court,
        limit: 1,
        queries: [FACET_SEED_QUERY[country]],
      }),
    }),
  });
  // A court its facet counted that yields no decision, or another court's
  // decision, is a failure, never a court left out: coverage that shrinks
  // silently would pass with nothing resolved.
  const searchFailures = samples.flatMap(({ court, sample }) => {
    if (typeof sample === "string") {
      return [`${court}: ${sample}`];
    }
    const hit = sample.results.at(0);
    if (hit === undefined) {
      return [`${court}: no decision`];
    }
    return isSameCourt(country, hit.court, court)
      ? []
      : [`${court}: sampled ${hit.court}`];
  });
  const hits = samples.flatMap(({ court, sample }) =>
    typeof sample === "string"
      ? []
      : sample.results
          .slice(0, 1)
          .filter((hit) => isSameCourt(country, hit.court, court)),
  );
  // Some courts publish no ECLI; their sample proves the docket only, so the
  // detail names them instead of counting the court as fully probed.
  const withoutEcli = hits.flatMap(({ court, ecli }) =>
    ecli === null || ecli === undefined ? [court] : [],
  );
  const checks = hits.flatMap((hit) =>
    expectationsOf(hit).map((expectation) => ({ expectation, hit })),
  );
  const resolutionFailures = await mapWithConcurrency({
    items: checks,
    limit: TOOL_CALL_CONCURRENCY,
    operation: async ({ expectation, hit }) =>
      await resolutionFailure(callTool, { country, hit }, expectation),
  });
  const failures = [
    ...searchFailures.map((detail) => `court sample: ${detail}`),
    ...resolutionFailures.flatMap((failure) =>
      failure === null ? [] : [failure],
    ),
  ];
  if (failures.length > 0) {
    const shown = failures.slice(0, FAILURES_REPORTED_MAX).join("; ");
    const more = failures.length - FAILURES_REPORTED_MAX;
    return {
      status: "failed",
      detail: `${String(failures.length)} of ${String(checks.length + searchFailures.length)} checks failed: ${shown}${more > 0 ? `; and ${String(more)} more` : ""}`,
    };
  }
  return {
    status: "passed",
    detail: `${String(checks.length)} identities across ${String(hits.length)} courts resolved to the decision search found${withoutEcli.length > 0 ? `; docket only (no ECLI sampled): ${withoutEcli.join(", ")}` : ""}`,
  };
};

/**
 * Sample every court search facets name in each probed country, resolve the
 * top decision of each by its docket and its ECLI, and require the
 * decision search found. A country whose search surface is closed has nothing
 * to sample from; it is probed as soon as the capability table opens it.
 */
export const sampleCaseLawIdentities = async (
  callTool: CallCaseLawTool,
  { wait = sleep }: { wait?: WaitFor } = {},
): Promise<{ country: ProbeCountry; outcome: CaseLawIdentityProbeOutcome }[]> =>
  await Promise.all(
    CASE_LAW_IDENTITY_PROBE_COUNTRIES.map(async (country) => ({
      country,
      outcome: PUBLIC_COUNTRY_SURFACE_OPEN.search[
        PUBLIC_COUNTRY_CAPABILITIES[country].caseLaw
      ]
        ? await probeCountry(callTool, wait, country)
        : SEARCH_CLOSED,
    })),
  );

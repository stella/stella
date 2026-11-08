/**
 * The deployed corpus holds to exact identity: a decision search finds,
 * resolved by its docket or its ECLI, is that decision. Sampled per court from
 * the live corpus, so a court whose identity model asks for parts its source
 * never publishes fails here rather than in a reader's hands.
 */
import { panic } from "better-result";
import * as v from "valibot";

import {
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_SURFACE_OPEN,
} from "@stll/api-contract/public-country-capability";
import { mapWithConcurrency } from "@stll/concurrency";

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

type CaseLawToolOutcome =
  { type: "ok"; payload: unknown } | { type: "error"; detail: string };

/** One MCP tool call against the deployment, its JSON payload parsed. */
export type CallCaseLawTool = (
  name: "resolve_case_law_decision" | "search_case_law",
  args: Record<string, unknown>,
) => Promise<CaseLawToolOutcome>;

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
  args: Record<string, unknown>,
): Promise<v.InferOutput<typeof searchPayloadSchema> | string> => {
  const outcome = await callTool("search_case_law", args);
  if (outcome.type === "error") {
    return outcome.detail;
  }
  const parsed = v.safeParse(searchPayloadSchema, outcome.payload);
  return parsed.success ? parsed.output : "unreadable search payload";
};

const SEARCH_CLOSED: CaseLawIdentityProbeOutcome = {
  status: "not_applicable",
  detail: "case-law search is not open, so no sample to resolve",
};

const probeCountry = async (
  callTool: CallCaseLawTool,
  country: ProbeCountry,
): Promise<CaseLawIdentityProbeOutcome> => {
  const seeded = await searchOf(callTool, {
    country,
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
      sample: await searchOf(callTool, {
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
    return hit.court === court ? [] : [`${court}: sampled ${hit.court}`];
  });
  const hits = samples.flatMap(({ court, sample }) =>
    typeof sample === "string"
      ? []
      : sample.results.slice(0, 1).filter((hit) => hit.court === court),
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
): Promise<{ country: ProbeCountry; outcome: CaseLawIdentityProbeOutcome }[]> =>
  await Promise.all(
    CASE_LAW_IDENTITY_PROBE_COUNTRIES.map(async (country) => ({
      country,
      outcome: PUBLIC_COUNTRY_SURFACE_OPEN.search[
        PUBLIC_COUNTRY_CAPABILITIES[country].caseLaw
      ]
        ? await probeCountry(callTool, country)
        : SEARCH_CLOSED,
    })),
  );

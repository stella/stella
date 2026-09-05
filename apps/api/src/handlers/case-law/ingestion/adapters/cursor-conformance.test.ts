/**
 * Cursor conformance: what every case-law adapter must do once its source
 * has nothing left to give.
 *
 * `handlers/case-law/CLAUDE.md` states the rule in prose — 13: an exhausted
 * cursor parks so it only re-scans a bounded recent window; 16: a
 * forward-only cursor cannot repair history — and nothing enforced it. A
 * test written next to an adapter cannot enforce it either: it certifies
 * whatever that adapter happens to do, which is how a passing test came to
 * assert a cursor that restarts a 33-year sweep on every cycle. So the check
 * lives outside the adapters, is driven from the registry, and every adapter
 * is subjected to the same walk.
 *
 * Each adapter is walked against a stubbed HTTP layer answering every
 * request the way a source does once every published item is already stored.
 * Offset-paginated sources remain populated: an empty upstream corpus cannot
 * distinguish a correct tail park from a reset to page one. Cursor grammars
 * differ per adapter (a date, an item offset, a `<walk>:<offset>`, a
 * `<number>:<year>`), so nothing here parses one: a cursor is an opaque
 * string, and the invariants are about the SHAPE of the sequence and the
 * FOOTPRINT of the requests that sequence drives.
 */

import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

// ── Bounds ───────────────────────────────────────────────

/**
 * How many `fetchPage` calls a walk may take before the cursor sequence has
 * to have closed a loop.
 *
 * An adapter is allowed a warm-up: several start from a cursor well behind
 * the present and step towards it one slice at a time. The longest honest
 * warm-up in the registry is SK ÚS, which begins at its court's first year
 * and advances a year per call (~34 steps today, one more per calendar
 * year); the populated SK Courts model below needs 101 steps to traverse its
 * backfill and then close one full live-window lap. 192 leaves both shapes
 * ample headroom while an adapter that never converges still fails in
 * seconds rather than running until the test times out.
 */
const MAX_WALK_STEPS = 192;

/**
 * Cursor and HTTP-position budgets live beside each adapter's source model.
 * One global ceiling would let a cheap list adapter inherit CZ ÚS's honest
 * ninety-probe allowance. The total record below makes every new adapter
 * declare both parts of its steady-state cost explicitly.
 */
/** Walks are stubbed and sleepless, but CZ ÚS still drives ~2000 requests. */
const WALK_TIMEOUT_MS = 120_000;

/** Stands in for the null start cursor when keying the sequence. */
const START_OF_WALK = "<null>";

// ── Exhausted-source stubs ───────────────────────────────

/**
 * How a source answers once every item it publishes is already stored.
 * Bespoke per adapter because list sources must stay populated while probe
 * and date-window sources legitimately answer with no recent matches. A
 * payload the adapter cannot parse is a fetch error, not an exhausted corpus,
 * and would prove nothing about its cursor.
 */
type ExhaustedSource = (request: {
  readonly method: string;
  readonly url: string;
}) => Response;

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const gzipJsonResponse = (body: unknown): Response =>
  new Response(Bun.gzipSync(JSON.stringify(body)), {
    headers: { "Content-Type": "application/gzip" },
  });

const htmlResponse = (body: string): Response =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const NALUS_SEARCH_FORM = `<html><body>
  <input id="__VIEWSTATE" value="view-state" />
  <input id="__EVENTVALIDATION" value="validation" />
</body></html>`;

const NALUS_NO_RESULTS = `<html><body>
  <span id="ctl00_MainContent_lbError">
    Pro zadaná kritéria nebyly nalezeny žádné záznamy.
  </span>
  <input id="ctl00_bResults" disabled="disabled" />
</body></html>`;

/** NSS hands out an antiforgery token before it will accept a search. */
const NSS_SESSION_PAGE = `<html><body><form>
  <input type="hidden" name="__RequestVerificationToken" value="conformance" />
</form></body></html>`;

/** A search that matched nothing renders no rows and no `currParams`. */
const NSS_NO_RESULTS_PAGE = "<html><body><table></table></body></html>";

// ── Coverage declaration ─────────────────────────────────

/**
 * What this suite does about one adapter. An adapter that cannot be driven
 * without a network, or that needs a stub nobody has written yet, is
 * excluded by name and reason — never skipped silently, and never absent.
 */
type AdapterCoverage =
  | {
      readonly disposition: "exercised";
      readonly exhaustedSource: ExhaustedSource;
      /** Adapter-specific count of cursors in one legitimate lap. */
      readonly maxSteadyStateCursors: number;
      /** Adapter-specific cost of one legitimate steady-state lap. */
      readonly maxSteadyStatePositions: number;
    }
  | { readonly disposition: "excluded"; readonly reason: string };

const AT_RIS_COVERAGE = {
  disposition: "exercised",
  exhaustedSource: () =>
    jsonResponse({
      OgdSearchResult: {
        OgdDocumentResults: {
          Hits: {
            "@pageNumber": "1",
            "@pageSize": "100",
            "#text": "0",
          },
        },
      },
    }),
  maxSteadyStateCursors: 4,
  maxSteadyStatePositions: 1,
} as const satisfies AdapterCoverage;

/**
 * Total over the adapter-key vocabulary, so a new jurisdiction fails to
 * compile until someone decides what happens to it here. `Record`, never
 * `Partial<Record>`: a missing decision is the outcome this suite exists to
 * make impossible.
 *
 */
const ADAPTER_CONFORMANCE = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    disposition: "exercised",
    exhaustedSource: () =>
      jsonResponse({ items: [], totalPages: 0, pageNumber: 0 }),
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 1,
  },
  [ADAPTER_KEYS.CZ_NS]: {
    disposition: "exercised",
    exhaustedSource: ({ url }) => {
      const start = Number(new URL(url).searchParams.get("Start"));
      const archiveEntries = 240;
      const pageSize = 40;
      const count = Math.max(0, Math.min(pageSize, archiveEntries - start + 1));
      return jsonResponse({
        "@toplevelentries": String(archiveEntries),
        viewentry: Array.from({ length: count }, () => ({})),
      });
    },
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 1,
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    disposition: "exercised",
    // The session GET precedes every search POST; only the POST carries a
    // date, so only the POST can report an empty day.
    exhaustedSource: ({ method }) =>
      htmlResponse(method === "POST" ? NSS_NO_RESULTS_PAGE : NSS_SESSION_PAGE),
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 2,
  },
  [ADAPTER_KEYS.CZ_US]: {
    disposition: "exercised",
    exhaustedSource: ({ method }) =>
      htmlResponse(method === "POST" ? NALUS_NO_RESULTS : NALUS_SEARCH_FORM),
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 96,
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    disposition: "exercised",
    // Numbered from one and clamped below it, as the endpoint is: `page=0`
    // answers the first hundred records, exactly like `page=1`. Modelling it
    // zero-indexed would hide a walk that re-reads its first page forever.
    exhaustedSource: ({ url }) => {
      const page = Math.max(1, Number(new URL(url).searchParams.get("page")));
      const pageSize = 100;
      const archiveEntries = 5100;
      const count = Math.max(
        0,
        Math.min(pageSize, archiveEntries - (page - 1) * pageSize),
      );
      return jsonResponse({
        rozhodnutieList: Array.from({ length: count }, () => ({})),
        numFound: archiveEntries,
      });
    },
    maxSteadyStateCursors: 50,
    maxSteadyStatePositions: 50,
  },
  [ADAPTER_KEYS.SK_US]: {
    disposition: "exercised",
    // The portal answers a search that matched nothing with a bare 204.
    exhaustedSource: () => new Response(null, { status: 204 }),
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 1,
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    disposition: "exercised",
    exhaustedSource: ({ url }) => {
      const page = Number(new URL(url).searchParams.get("pageNumber"));
      const pageSize = 100;
      const archiveEntries = 501;
      const count = Math.max(
        0,
        Math.min(pageSize, archiveEntries - page * pageSize),
      );
      return jsonResponse({
        items: Array.from({ length: count }, () => ({})),
      });
    },
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 1,
  },
  [ADAPTER_KEYS.AT_COURTS]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_VFGH]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_VWGH]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_BVWG]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_LVWG]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_ASYLGH]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_UBAS]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_UVS]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_VERG]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_UMSE]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_BKS]: AT_RIS_COVERAGE,
  [ADAPTER_KEYS.AT_FINDOK]: {
    disposition: "exercised",
    exhaustedSource: () =>
      gzipJsonResponse({
        generierungsdatum: "07.08.2026 06:16",
        data: [],
      }),
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 1,
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    disposition: "exercised",
    exhaustedSource: () =>
      jsonResponse({ head: { vars: [] }, results: { bindings: [] } }),
    maxSteadyStateCursors: 4,
    maxSteadyStatePositions: 1,
  },
} as const satisfies Record<AdapterKey, AdapterCoverage>;

/**
 * Reading the declaration widens it back to the union. The literal type
 * `satisfies` produced is what makes the record total; the union is what
 * makes an exclusion expressible at the point of use.
 */
const coverageFor = (key: AdapterKey): AdapterCoverage =>
  ADAPTER_CONFORMANCE[key];

const DECLARED_ADAPTER_KEYS = Object.values(ADAPTER_KEYS);

// ── Walk harness ─────────────────────────────────────────

const resolveUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

/**
 * A position is what the request asks the source for, not the endpoint it
 * asks. Adapters that page by POST body (a SPARQL query, a search filter,
 * an ASP.NET form) hit one URL for every slice of the corpus, so the body
 * has to be part of the identity or their footprint would read as 1 no
 * matter how much they swept.
 */
const positionKey = (
  method: string,
  url: string,
  body: RequestInit["body"],
): string =>
  typeof body === "string" && body.length > 0
    ? `${method} ${url} ${body}`
    : `${method} ${url}`;

type ExhaustedProbe = {
  readonly positions: Set<string>;
  readonly restore: () => void;
};

const installExhaustedSource = (respond: ExhaustedSource): ExhaustedProbe => {
  const originalFetch = globalThis.fetch;
  const positions = new Set<string>();

  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = resolveUrl(input);
      const method = init?.method ?? "GET";
      positions.add(positionKey(method, url, init?.body));
      return await Promise.resolve(respond({ method, url }));
    },
  );

  return {
    positions,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

/** One `fetchPage` call and what it cost. */
type WalkStep = {
  /** Cursor handed in. `null` only on the first step. */
  readonly from: string | null;
  /** Cursor handed back. */
  readonly to: string;
  /** Distinct source positions this step requested. */
  readonly positions: readonly string[];
};

type WalkOutcome =
  | {
      readonly type: "converged";
      readonly steps: readonly WalkStep[];
      /** Exactly one lap of the repeating tail. */
      readonly steadyState: readonly WalkStep[];
    }
  /** Still emitting never-before-seen cursors when the cap ran out. */
  | { readonly type: "diverged"; readonly steps: readonly WalkStep[] }
  /** Returned `null`, which restarts the adapter from scratch (rule 13). */
  | { readonly type: "restarted"; readonly steps: readonly WalkStep[] }
  | {
      readonly type: "errored";
      readonly steps: readonly WalkStep[];
      readonly message: string;
    };

const walkExhausted = async (
  adapter: SourceAdapter,
  respond: ExhaustedSource,
): Promise<WalkOutcome> => {
  const steps: WalkStep[] = [];
  const firstSeenAt = new Map<string, number>();
  let cursor: string | null = null;

  for (let step = 0; step < MAX_WALK_STEPS; step++) {
    const key = cursor ?? START_OF_WALK;
    const seenAt = firstSeenAt.get(key);
    if (seenAt !== undefined) {
      return { type: "converged", steps, steadyState: steps.slice(seenAt) };
    }
    firstSeenAt.set(key, steps.length);

    const probe = installExhaustedSource(respond);
    const result = await adapter.fetchPage(cursor, {});
    probe.restore();

    if (!Result.isOk(result)) {
      return { type: "errored", steps, message: result.error.message };
    }
    const { nextCursor } = result.value;
    if (nextCursor === null) {
      return { type: "restarted", steps };
    }

    steps.push({
      from: cursor,
      to: nextCursor,
      positions: [...probe.positions],
    });
    cursor = nextCursor;
  }

  return { type: "diverged", steps };
};

const formatSequence = (steps: readonly WalkStep[]): string =>
  [...steps.map((step) => step.from ?? "null"), steps.at(-1)?.to ?? "-"].join(
    " -> ",
  );

const distinctPositions = (steps: readonly WalkStep[]): string[] => [
  ...new Set(steps.flatMap((step) => step.positions)),
];

/** Enough of the footprint to recognise the sweep, not all thousand of it. */
const POSITION_SAMPLE = 6;

const describeFootprint = (positions: readonly string[]): string =>
  `${positions.length} distinct positions, e.g. ${positions
    .slice(0, POSITION_SAMPLE)
    .join(", ")}`;

// ── Invariants ───────────────────────────────────────────

describe("an exhausted source leaves every adapter parked", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    // Adapters pace themselves against live courts. Nothing here is live.
    Bun.sleep = async () => {
      // no-op
    };
  });

  afterEach(() => {
    // The walk restores fetch after every step; this covers the step that
    // never returned, so one adapter's stub can never answer the next one's.
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  for (const key of DECLARED_ADAPTER_KEYS) {
    const coverage = coverageFor(key);

    if (coverage.disposition === "excluded") {
      test.skip(`${key}: excluded — ${coverage.reason}`, () => {
        expect(coverage.reason.length).toBeGreaterThan(0);
      });
      continue;
    }

    test(
      `${key}: parks within a bounded window`,
      async () => {
        const adapter = getAdapter(key);
        expect(adapter, `${key} is declared but not registered`).toBeDefined();
        if (adapter === undefined) {
          return;
        }

        const outcome = await walkExhausted(adapter, coverage.exhaustedSource);

        switch (outcome.type) {
          case "errored": {
            throw new Error(
              `${key}: the exhausted-source stub does not satisfy this adapter (${outcome.message}). Fix the stub; an unparseable payload proves nothing about the cursor.`,
            );
          }
          case "restarted": {
            throw new Error(
              `${key}: returned a null cursor, which restarts the adapter from scratch instead of parking (rule 13). Sequence: ${formatSequence(outcome.steps)}`,
            );
          }
          case "diverged": {
            throw new Error(
              `${key}: still emitting never-before-seen cursors after ${MAX_WALK_STEPS} steps against an exhausted source, so the sweep never converges. Sequence: ${formatSequence(outcome.steps)}`,
            );
          }
          case "converged": {
            // 2. Bounded steady state, by cursor.
            expect(
              outcome.steadyState.length,
              `${key}: steady state spans ${outcome.steadyState.length} cursors, above the adapter-specific bound of ${coverage.maxSteadyStateCursors}. Sequence: ${formatSequence(outcome.steps)}`,
            ).toBeLessThanOrEqual(coverage.maxSteadyStateCursors);

            // 2/3. Bounded steady state, by what a lap actually re-fetches.
            const positions = distinctPositions(outcome.steadyState);
            expect(
              positions.length,
              `${key}: one lap of the parked cursor re-fetches ${describeFootprint(positions)}. The adapter-specific bound is ${coverage.maxSteadyStatePositions}: a parked adapter re-checks a bounded recent window, it does not re-sweep its corpus (rules 13 and 16). Sequence: ${formatSequence(outcome.steps)}`,
            ).toBeLessThanOrEqual(coverage.maxSteadyStatePositions);
            break;
          }
          default: {
            const unhandled: never = outcome;
            throw new Error(`Unhandled walk outcome: ${String(unhandled)}`);
          }
        }
      },
      WALK_TIMEOUT_MS,
    );
  }
});

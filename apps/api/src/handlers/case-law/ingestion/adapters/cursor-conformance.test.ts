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
 * request the way an exhausted source does — no hits, no items, no bindings
 * — from a null cursor, threading `nextCursor` forward. Cursor grammars
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
import {
  getAdapter,
  listAdapters,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
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
 * year); the date-cursor adapters begin a 30-day lookback behind and advance
 * a day per call (~31 steps). 96 keeps roughly two and a half times the
 * longest of those, so the cap stays clear of the warm-up for decades, while
 * an adapter that never converges still fails in seconds rather than
 * running until the test times out.
 */
const MAX_WALK_STEPS = 96;

/**
 * How many distinct cursors the steady state may span.
 *
 * Rule 13's park is a fixed point: one cursor, re-checked. A handover
 * between an adapter's declared walks (backfill to live) settles into one
 * too. A couple more allows a park that alternates between neighbouring
 * positions without permitting a steady state whose size tracks the corpus
 * — which is the failure being guarded against, and which runs to thousands.
 */
const MAX_STEADY_STATE_CURSORS = 4;

/**
 * How many distinct source positions one lap of the steady state may touch.
 *
 * This is where a re-sweep shows itself. A cursor sequence can look
 * perfectly convergent while the call behind it walks the whole archive:
 * an adapter that probes its way from the present back to the court's first
 * year inside a single `fetchPage` returns one parked cursor and re-fetches
 * the entire corpus to produce it. Counting the distinct positions requested
 * per lap sees that; counting cursors does not.
 *
 * A parked adapter re-checks one recent window. Where the source offers a
 * list or search endpoint that is a single request, plus at most a session
 * handshake and a page-boundary follow-up; every such adapter here sits at
 * one or two.
 *
 * A source that publishes no list endpoint cannot be that cheap. Discovering
 * whether anything new exists means probing case numbers until enough
 * consecutive misses prove the year is exhausted, so its floor is the miss
 * threshold times the years in its window — for CZ ÚS, thirty misses across
 * a three-year window, or ninety. That is the honest price of the window,
 * and it stays flat as the corpus grows.
 *
 * So the bound has to separate "proportional to the window" from
 * "proportional to the corpus" rather than simply reward small numbers. 128
 * admits the probing shape with headroom, and still rejects the same
 * adapter re-sweeping its archive by a factor of eight (that costs ~1020
 * positions, thirty probes across all thirty-four years, and grows by
 * another thirty every January).
 *
 * This bound also carries invariant 3, unbounded regression: an adapter that
 * walks backwards without a floor cannot keep its per-lap footprint small,
 * whatever its cursor grammar, so no cursor string has to be parsed to
 * detect it.
 */
const MAX_STEADY_STATE_POSITIONS = 128;

/** Walks are stubbed and sleepless, but CZ ÚS still drives ~2000 requests. */
const WALK_TIMEOUT_MS = 120_000;

/** Stands in for the null start cursor when keying the sequence. */
const START_OF_WALK = "<null>";

// ── Exhausted-source stubs ───────────────────────────────

/**
 * How a source answers while it holds nothing the crawl has not already
 * seen. Bespoke per adapter, because "no results" is only legible in the
 * source's own envelope: a payload the adapter cannot parse is a fetch
 * error, not an exhausted corpus, and would prove nothing about its cursor.
 */
type ExhaustedSource = (request: {
  readonly method: string;
  readonly url: string;
}) => Response;

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const htmlResponse = (body: string): Response =>
  new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

/** NALUS serves a decision page with no registry sign for a free number. */
const NALUS_EMPTY_DECISION = `<html><body>
  <span id="lblRegistrySign" class="DocRegistrySign"></span>
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
    }
  | { readonly disposition: "excluded"; readonly reason: string };

/**
 * Total over the adapter-key vocabulary, so a new jurisdiction fails to
 * compile until someone decides what happens to it here. `Record`, never
 * `Partial<Record>`: a missing decision is the outcome this suite exists to
 * make impossible.
 *
 * The runtime half of the totality check ties this vocabulary to the
 * registry itself, in both directions, further down.
 */
const ADAPTER_CONFORMANCE = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    disposition: "exercised",
    exhaustedSource: () =>
      jsonResponse({ items: [], totalPages: 0, pageNumber: 0 }),
  },
  [ADAPTER_KEYS.CZ_NS]: {
    disposition: "exercised",
    exhaustedSource: () =>
      jsonResponse({ "@toplevelentries": "0", viewentry: [] }),
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    disposition: "exercised",
    // The session GET precedes every search POST; only the POST carries a
    // date, so only the POST can report an empty day.
    exhaustedSource: ({ method }) =>
      htmlResponse(method === "POST" ? NSS_NO_RESULTS_PAGE : NSS_SESSION_PAGE),
  },
  [ADAPTER_KEYS.CZ_US]: {
    disposition: "exercised",
    exhaustedSource: () => htmlResponse(NALUS_EMPTY_DECISION),
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    disposition: "exercised",
    exhaustedSource: () => jsonResponse({ rozhodnutieList: [], numFound: 0 }),
  },
  [ADAPTER_KEYS.SK_US]: {
    disposition: "exercised",
    // The portal answers a search that matched nothing with a bare 204.
    exhaustedSource: () => new Response(null, { status: 204 }),
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    disposition: "exercised",
    exhaustedSource: () => jsonResponse({ items: [] }),
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    disposition: "exercised",
    exhaustedSource: () =>
      jsonResponse({
        OgdSearchResult: {
          OgdDocumentResults: {
            Hits: { "#text": "0" },
            OgdDocumentReference: [],
          },
        },
      }),
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    disposition: "exercised",
    exhaustedSource: () =>
      jsonResponse({ head: { vars: [] }, results: { bindings: [] } }),
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
    // oxlint-disable-next-line no-await-in-loop -- each step's cursor is the previous step's output; that dependency is the thing under test
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

// ── Totality ─────────────────────────────────────────────

describe("adapter cursor conformance covers the registry", () => {
  const registered = listAdapters()
    .map((adapter) => adapter.key)
    .toSorted();
  const declared = Object.keys(ADAPTER_CONFORMANCE).toSorted();

  test("every registered adapter is declared here", () => {
    const undeclared = registered.filter((key) => !declared.includes(key));
    expect(
      undeclared,
      "adapters in ADAPTER_REGISTRY with no entry in ADAPTER_CONFORMANCE: " +
        "cover them with an exhausted-source stub, or exclude them by name " +
        "with a reason",
    ).toEqual([]);
  });

  test("every declared adapter is registered", () => {
    const unregistered = declared.filter((key) => !registered.includes(key));
    expect(
      unregistered,
      "entries in ADAPTER_CONFORMANCE that name no adapter in " +
        "ADAPTER_REGISTRY: the declaration has outlived what it described",
    ).toEqual([]);
  });

  test("declared set equals registered set", () => {
    expect(declared).toEqual(registered);
  });
});

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
              `${key}: steady state spans ${outcome.steadyState.length} cursors, above the bound of ${MAX_STEADY_STATE_CURSORS}. Sequence: ${formatSequence(outcome.steps)}`,
            ).toBeLessThanOrEqual(MAX_STEADY_STATE_CURSORS);

            // 2/3. Bounded steady state, by what a lap actually re-fetches.
            const positions = distinctPositions(outcome.steadyState);
            expect(
              positions.length,
              `${key}: one lap of the parked cursor re-fetches ${describeFootprint(positions)}. The bound is ${MAX_STEADY_STATE_POSITIONS}: a parked adapter re-checks a bounded recent window, it does not re-sweep its corpus (rules 13 and 16). Sequence: ${formatSequence(outcome.steps)}`,
            ).toBeLessThanOrEqual(MAX_STEADY_STATE_POSITIONS);
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

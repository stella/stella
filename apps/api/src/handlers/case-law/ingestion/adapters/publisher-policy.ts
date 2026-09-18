/**
 * What each publisher costs, declared once, and the only fetch that spends it.
 *
 * A budget an adapter keeps for itself is a budget the next adapter does not
 * know about, and a loop that reaches the publisher through a plain `fetch`
 * spends requests nothing counts. So the pacing is not a habit of any loop:
 * every adapter names its publisher here, every publisher names its interval
 * here, and `retry.ts` reserves a slot before the request leaves.
 * `publisher-gate-coverage.test.ts` fails the build on an adapter module that
 * reaches the network any other way.
 *
 * The interval is the declared figure and the daily ceiling is derived from
 * it ({@link publisherRequestsPerDay}), not the other way round: it is what
 * the gate enforces, and three of these publishers stated a gap between
 * requests rather than a total.
 */

import { DAY_IN_MS } from "@stll/time";

import {
  createPublisherRequestSlot,
  publisherGateReserves,
  type PublisherRequestGateDependencies,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-request-gate";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

type PublisherGate = {
  /** Named in gate errors and logs; the publisher, not the adapter. */
  readonly publisher: string;
  /** Minimum gap between two requests to this publisher, in milliseconds. */
  readonly intervalMs: number;
};

/**
 * A politeness floor, not a publisher statement.
 *
 * Two requests a second sustained is well under what any of these endpoints
 * has refused, and it is small enough that a loop which starts spinning costs
 * a number an operator can reason about instead of whatever the network
 * allows. A publisher that states a limit gets its own entry; a publisher
 * that agrees to an interval gets that interval verbatim.
 */
const POLITE_INTERVAL_MS = 500;

/**
 * The ceiling nalus.usoud.cz states to an over-quota client: "The maximum
 * allowed limit for automated scrapers is 5,000 requests per day."
 */
export const NALUS_DAILY_REQUEST_LIMIT = 5000;

/** The share of the stated NALUS limit this worker spends; the rest is margin. */
const NALUS_REQUEST_BUDGET_SHARE = 0.96;

/**
 * Every publisher this slice talks to, with what one request to it costs in
 * waiting. Several adapters may name the same gate: one publisher serving ten
 * Austrian tribunals is one budget, not ten.
 */
export const PUBLISHER_GATES = {
  /**
   * nalus.usoud.cz. 4,800 requests a day against the 5,000 the court allows,
   * and it redirects a client past the ceiling to a limit page rather than
   * refusing the request outright — see `cz-us-throttle.ts`.
   */
  "nalus-usoud": {
    publisher: "NALUS",
    intervalMs: Math.ceil(
      DAY_IN_MS / (NALUS_DAILY_REQUEST_LIMIT * NALUS_REQUEST_BUDGET_SHARE),
    ),
  },
  /** ris.bka.gv.at and data.bka.gv.at. */
  "ris-bka": { publisher: "RIS", intervalMs: 5000 },
  /** findok.bmf.gv.at. */
  "findok-bmf": { publisher: "Findok", intervalMs: 1500 },
  /**
   * sn.pl. A dozen requests in quick succession earned the upstream's 429
   * dressed as `{"error":"Brak tokenu"}`; the same pacing then answered
   * normally.
   */
  "sn-pl": { publisher: "Sąd Najwyższy", intervalMs: 1000 },
  /** rozhodnuti.nsoud.cz. */
  "nsoud-cz": { publisher: "Nejvyšší soud", intervalMs: POLITE_INTERVAL_MS },
  /** vyhledavac.nssoud.cz. */
  "nssoud-cz": {
    publisher: "Nejvyšší správní soud",
    intervalMs: POLITE_INTERVAL_MS,
  },
  /** rozhodnuti.justice.cz. */
  "justice-cz": {
    publisher: "Justice.cz",
    intervalMs: POLITE_INTERVAL_MS,
  },
  /** obcan.justice.sk. */
  "justice-sk": {
    publisher: "Justice.sk",
    intervalMs: POLITE_INTERVAL_MS,
  },
  /** www.ustavnysud.sk. */
  "ustavnysud-sk": {
    publisher: "Ústavný súd SR",
    intervalMs: POLITE_INTERVAL_MS,
  },
  /** www.saos.org.pl. */
  "saos-pl": { publisher: "SAOS", intervalMs: POLITE_INTERVAL_MS },
  /** publications.europa.eu, both the SPARQL endpoint and Cellar. */
  "cellar-eu": {
    publisher: "EU Publications Office",
    intervalMs: POLITE_INTERVAL_MS,
  },
} as const satisfies Record<string, PublisherGate>;

export type PublisherGateId = keyof typeof PUBLISHER_GATES;

/**
 * Which publisher each adapter spends against.
 *
 * Total by type: an adapter key added to {@link ADAPTER_KEYS} without a
 * publisher does not compile, which is the point — an adapter cannot reach
 * the network without first having named whose budget it is spending.
 */
export const ADAPTER_PUBLISHER_GATES = {
  [ADAPTER_KEYS.CZ_US]: "nalus-usoud",
  [ADAPTER_KEYS.CZ_NS]: "nsoud-cz",
  [ADAPTER_KEYS.CZ_NSS]: "nssoud-cz",
  [ADAPTER_KEYS.CZ_REGIONAL]: "justice-cz",
  [ADAPTER_KEYS.SK_COURTS]: "justice-sk",
  [ADAPTER_KEYS.SK_US]: "ustavnysud-sk",
  [ADAPTER_KEYS.PL_COURTS]: "saos-pl",
  [ADAPTER_KEYS.PL_SN]: "sn-pl",
  [ADAPTER_KEYS.AT_COURTS]: "ris-bka",
  [ADAPTER_KEYS.AT_VFGH]: "ris-bka",
  [ADAPTER_KEYS.AT_VWGH]: "ris-bka",
  [ADAPTER_KEYS.AT_BVWG]: "ris-bka",
  [ADAPTER_KEYS.AT_LVWG]: "ris-bka",
  [ADAPTER_KEYS.AT_ASYLGH]: "ris-bka",
  [ADAPTER_KEYS.AT_UBAS]: "ris-bka",
  [ADAPTER_KEYS.AT_UVS]: "ris-bka",
  [ADAPTER_KEYS.AT_VERG]: "ris-bka",
  [ADAPTER_KEYS.AT_UMSE]: "ris-bka",
  [ADAPTER_KEYS.AT_BKS]: "ris-bka",
  [ADAPTER_KEYS.AT_FINDOK]: "findok-bmf",
  [ADAPTER_KEYS.EU_ECJ]: "cellar-eu",
} as const satisfies Record<AdapterKey, PublisherGateId>;

/** Minimum gap between two requests the adapter sends to its publisher. */
export const publisherRequestIntervalMs = (adapterKey: AdapterKey): number =>
  PUBLISHER_GATES[ADAPTER_PUBLISHER_GATES[adapterKey]].intervalMs;

/** What the declared interval leaves the whole slice per publisher per day. */
export const publisherRequestsPerDay = (gateId: PublisherGateId): number =>
  Math.floor(DAY_IN_MS / PUBLISHER_GATES[gateId].intervalMs);

/**
 * The gate for one adapter's publisher, with the reservation seam exposed.
 *
 * Tests reach the gate through this to drive the reservation without Redis
 * or a clock; production goes through {@link fetchPublisher}.
 */
export const createPublisherSlot = (
  adapterKey: AdapterKey,
  dependencies?: PublisherRequestGateDependencies,
): ((signal?: AbortSignal) => Promise<void>) => {
  const gateId = ADAPTER_PUBLISHER_GATES[adapterKey];
  const { publisher, intervalMs } = PUBLISHER_GATES[gateId];
  return createPublisherRequestSlot(
    { intervalMs, key: `case-law:publisher-gate:${gateId}`, publisher },
    dependencies,
  );
};

/**
 * One reserver per gate, created on first use.
 *
 * Lazy rather than a map built at import: the gate resolves its Redis client
 * when it first reserves, and a module that builds every gate eagerly would
 * pull that resolution into import order.
 */
const slotsByGate = new Map<
  PublisherGateId,
  (signal?: AbortSignal) => Promise<void>
>();

export const reservePublisherSlot = async (
  adapterKey: AdapterKey,
  signal?: AbortSignal,
): Promise<void> => {
  if (!publisherGateReserves()) {
    return;
  }
  const gateId = ADAPTER_PUBLISHER_GATES[adapterKey];
  const reserve = slotsByGate.get(gateId) ?? createPublisherSlot(adapterKey);
  slotsByGate.set(gateId, reserve);
  await reserve(signal);
};

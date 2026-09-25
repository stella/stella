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
  /**
   * The hosts this publisher serves from, as a request names them. A URL the
   * publisher hands back is only followed onto one of these; see
   * `publisher-target.ts`.
   */
  readonly hosts: readonly string[];
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
    hosts: ["nalus.usoud.cz"],
  },
  /** ris.bka.gv.at and data.bka.gv.at. */
  "ris-bka": {
    publisher: "RIS",
    intervalMs: 5000,
    hosts: ["data.bka.gv.at", "ogd.ris.bka.gv.at", "www.ris.bka.gv.at"],
  },
  /** findok.bmf.gv.at. */
  "findok-bmf": {
    publisher: "Findok",
    intervalMs: 1500,
    hosts: ["findok.bmf.gv.at"],
  },
  /**
   * sn.pl. A dozen requests in quick succession earned the upstream's 429
   * dressed as `{"error":"Brak tokenu"}`; the same pacing then answered
   * normally. A sustained request a second was still refused every few
   * minutes, each refusal clearing within one.
   */
  "sn-pl": {
    publisher: "Sąd Najwyższy",
    intervalMs: 1500,
    hosts: ["sn.pl"],
  },
  /** orzeczenia.uzp.gov.pl. */
  "uzp-pl": {
    publisher: "Urząd Zamówień Publicznych",
    intervalMs: 1000,
    hosts: ["orzeczenia.uzp.gov.pl"],
  },
  /** ipo.trybunal.gov.pl. */
  "trybunal-pl": {
    publisher: "Trybunał Konstytucyjny",
    intervalMs: 1500,
    hosts: ["ipo.trybunal.gov.pl"],
  },
  /** apiorzeczenia.wroclaw.sa.gov.pl, the common courts' judgments API. */
  "ms-gov-pl": {
    publisher: "Ministerstwo Sprawiedliwości",
    intervalMs: 1000,
    hosts: ["apiorzeczenia.wroclaw.sa.gov.pl"],
  },
  /** rozhodnuti.nsoud.cz. */
  "nsoud-cz": {
    publisher: "Nejvyšší soud",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["rozhodnuti.nsoud.cz"],
  },
  /** vyhledavac.nssoud.cz. */
  "nssoud-cz": {
    publisher: "Nejvyšší správní soud",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["vyhledavac.nssoud.cz"],
  },
  /** rozhodnuti.justice.cz. */
  "justice-cz": {
    publisher: "Justice.cz",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["rozhodnuti.justice.cz"],
  },
  /** obcan.justice.sk. */
  "justice-sk": {
    publisher: "Justice.sk",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["obcan.justice.sk"],
  },
  /**
   * www.usoud.cz, the court's own site rather than its decision database:
   * the judge roster and the pages it links. A budget of its own because it
   * is a different host with a different limit, and one the roster import
   * would otherwise spend uncounted.
   */
  "usoud-cz": {
    publisher: "Ústavní soud",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["www.usoud.cz"],
  },
  /** www.ustavnysud.sk. */
  "ustavnysud-sk": {
    publisher: "Ústavný súd SR",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["www.ustavnysud.sk"],
  },
  /** www.saos.org.pl. */
  "saos-pl": {
    publisher: "SAOS",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["www.saos.org.pl"],
  },
  /**
   * huggingface.co and the CDN it redirects file reads to. Few requests: a
   * shard is a dozen ranged reads of a pinned file.
   */
  "huggingface-datasets": {
    publisher: "Hugging Face",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["huggingface.co"],
  },
  /**
   * orzeczenia.uodo.gov.pl. Politeness, not a publisher statement: the portal
   * states no limit, and this keeps it under one request a second.
   */
  "uodo-gov-pl": {
    publisher: "Prezes UODO",
    intervalMs: 1000,
    hosts: ["orzeczenia.uodo.gov.pl"],
  },
  /** eakta.birosag.hu. */
  "birosag-hu": {
    publisher: "Országos Bírósági Hivatal",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["eakta.birosag.hu"],
  },
  /**
   * eureka.mf.gov.pl. The service states no limit; one request a second is
   * politeness, and its search stalls rather than refuses under load.
   */
  "eureka-mf": {
    publisher: "EUREKA",
    intervalMs: 1000,
    hosts: ["eureka.mf.gov.pl"],
  },
  /** publications.europa.eu, both the SPARQL endpoint and Cellar. */
  "cellar-eu": {
    publisher: "EU Publications Office",
    intervalMs: POLITE_INTERVAL_MS,
    hosts: ["publications.europa.eu"],
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
  [ADAPTER_KEYS.PL_KIO]: "uzp-pl",
  [ADAPTER_KEYS.PL_TK]: "trybunal-pl",
  [ADAPTER_KEYS.PL_NSA]: "huggingface-datasets",
  [ADAPTER_KEYS.PL_NCOURT]: "ms-gov-pl",
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
  [ADAPTER_KEYS.HU_BHGY]: "birosag-hu",
  [ADAPTER_KEYS.PL_KIS]: "eureka-mf",
  [ADAPTER_KEYS.PL_UODO]: "uodo-gov-pl",
} as const satisfies Record<AdapterKey, PublisherGateId>;

/** The hosts an adapter's publisher serves from. */
export const publisherHosts = (adapterKey: AdapterKey): readonly string[] =>
  PUBLISHER_GATES[ADAPTER_PUBLISHER_GATES[adapterKey]].hosts;

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
): ((signal?: AbortSignal) => Promise<void>) =>
  createPublisherGateSlot(ADAPTER_PUBLISHER_GATES[adapterKey], dependencies);

/**
 * The gate for a publisher this slice reaches outside a crawl — a roster
 * import, say. Named by gate rather than by adapter, because the host it
 * spends against is not the one any adapter's cursor walks.
 */
export const createPublisherGateSlot = (
  gateId: PublisherGateId,
  dependencies?: PublisherRequestGateDependencies,
): ((signal?: AbortSignal) => Promise<void>) => {
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

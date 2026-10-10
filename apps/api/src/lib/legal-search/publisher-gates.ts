// parser-output-unchanged: the EU Publications Office gate paces one request per second; request timing only, parsed output is unchanged.
import { DAY_IN_MS } from "@stll/time";

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
 * Every corpus publisher, with what one request to it costs in
 * waiting. Several adapters may name the same gate: one publisher serving ten
 * Austrian tribunals is one budget, not ten.
 */
export const PUBLISHER_GATES = {
  "uoou-cz": { publisher: "ÚOOÚ", intervalMs: 1000, hosts: ["uoou.gov.cz"] },
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
  "nsud-sk": {
    publisher: "Najvyšší súd SR",
    intervalMs: 2000,
    hosts: ["www.nsud.sk"],
  },
  "nssud-sk": {
    publisher: "Najvyšší správny súd SR",
    intervalMs: 2000,
    hosts: ["www.nssud.sk"],
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
  /**
   * decyzje.uokik.gov.pl. Politeness, not a publisher statement: the register
   * states no limit, and two seconds between requests keeps a crawl
   * sequential and slow.
   */
  "uokik-gov-pl": {
    publisher: "Prezes UOKiK",
    intervalMs: 2000,
    hosts: ["decyzje.uokik.gov.pl"],
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
    intervalMs: 1000,
    hosts: ["publications.europa.eu"],
  },
} as const satisfies Record<string, PublisherGate>;

export type PublisherGateId = keyof typeof PUBLISHER_GATES;

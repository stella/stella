import type { WebSearchJurisdiction } from "@/api/lib/web-search/types";

/**
 * Per-jurisdiction allowlist of court, legislation, and public-registry
 * domains. Providers that accept `include_domains` (Tavily, Brave) read
 * from here; `global` is the empty list so the open web is searched
 * without bias.
 *
 * Treat additions as a product decision: every entry is a domain whose
 * content Stella implicitly trusts more than the open web. Prefer
 * primary sources (courts, official journals, statute repositories)
 * over commentary aggregators.
 */
export const JURISDICTION_ALLOWLIST_DOMAINS: Record<
  WebSearchJurisdiction,
  readonly string[]
> = {
  cz: [
    "nsoud.cz",
    "usoud.cz",
    "nssoud.cz",
    "psp.cz",
    "justice.cz",
    "zakonyprolidi.cz",
    "aspi.cz",
  ],
  sk: ["nsud.sk", "ustavnysud.sk", "slov-lex.sk", "justice.gov.sk"],
  de: [
    "bundesgerichtshof.de",
    "bverfg.de",
    "bverwg.de",
    "gesetze-im-internet.de",
    "dejure.org",
    "rechtsprechung-im-internet.de",
  ],
  at: ["ris.bka.gv.at", "ogh.gv.at", "vfgh.gv.at", "vwgh.gv.at"],
  eu: [
    "eur-lex.europa.eu",
    "curia.europa.eu",
    "europa.eu",
    "echr.coe.int",
    "hudoc.echr.coe.int",
  ],
  global: [],
};

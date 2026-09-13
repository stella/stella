import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

type DecisionSourceAttributionInput = {
  /** The `case_law_sources.adapter_key` the decision was ingested under. */
  adapterKey: string;
  /** The publisher's own page for this decision, where one was captured. */
  sourceUrl: string | null;
};

const isAdapterKey = (value: string): value is AdapterKey =>
  Object.values(ADAPTER_KEYS).some((key) => key === value);

/**
 * A URL a reader can follow, or null. `source_url` is whatever the adapter
 * captured, so it can be empty, a `ftp:` location, or not a URL at all.
 */
const browsableUrl = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) {
    return null;
  }
  const { protocol } = new URL(trimmed);
  return protocol === "http:" || protocol === "https:" ? trimmed : null;
};

/**
 * Where this decision's data is freely available, for the attribution line
 * the reader ends with.
 *
 * The decision's own source page wins: it is the page a reader would check
 * the text against. A row without one falls back to the publisher's landing
 * page, which the adapter manifest makes every source declare.
 *
 * Null only for a decision ingested under an adapter key no longer in the
 * registry: source rows are history and a retired adapter leaves its rows
 * behind, so a key with no manifest is reported as no attribution rather
 * than attributed to whichever publisher happens to be first in the map.
 */
export const decisionSourceAttributionUrl = ({
  adapterKey,
  sourceUrl,
}: DecisionSourceAttributionInput): string | null =>
  browsableUrl(sourceUrl) ??
  (isAdapterKey(adapterKey)
    ? ADAPTER_MANIFESTS[adapterKey].publicHomeUrl
    : null);

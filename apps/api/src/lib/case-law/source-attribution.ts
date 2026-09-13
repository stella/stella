import { captureError } from "@/api/lib/analytics/capture";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
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
 * Null means the row names an adapter key the manifest map does not hold,
 * which is a defect rather than a state to render around: a decision loses
 * its attribution line, and some courts make that line a condition of reuse.
 * The manifest is what a retired adapter leaves behind (see `publicHomeUrl`),
 * so the miss is reported rather than swallowed, and never answered with
 * whichever publisher happens to be first in the map.
 */
export const decisionSourceAttributionUrl = ({
  adapterKey,
  sourceUrl,
}: DecisionSourceAttributionInput): string | null => {
  const ownPage = browsableUrl(sourceUrl);
  if (ownPage !== null) {
    return ownPage;
  }
  if (isAdapterKey(adapterKey)) {
    return ADAPTER_MANIFESTS[adapterKey].publicHomeUrl;
  }
  captureError(
    new DatabaseError({
      message: "Case-law source names an unregistered adapter key",
    }),
    { source: "case-law-source-attribution", adapterKey },
  );
  return null;
};

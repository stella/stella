import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import type { OutboundHostPolicy } from "@/api/lib/restrict-outbound-url";

/**
 * The URL boundary for legislation ingestion (case-law rule 21).
 *
 * A URL that arrives in a publisher's HTML or JSON is untrusted input, and a
 * stored one is a future fetch target: the reader follows it, a re-crawl
 * fetches it, an operator opens it. Checking it once here — in the runner,
 * over every URL-bearing field of every document a page returns — is what
 * makes the guarantee hold for adapters nobody has written yet. Per-adapter
 * checks are a guard one adapter will eventually forget to call.
 */

/** Every `…Url` field the persisted document input carries. */
export type LegislationUrlBearingField = keyof {
  [K in keyof LegislationDocumentInput as K extends `${string}Url`
    ? K
    : never]: unknown;
};

/**
 * The fields the guard rewrites. Constrained to the derived set above, so a
 * field listed here that the input does not carry fails to compile; the
 * other direction (a new `…Url` field nobody added here) is asserted in
 * `outbound-urls.test.ts`, where an uncovered field breaks the build.
 */
export const LEGISLATION_URL_FIELDS = [
  "sourceUrl",
  "documentUrl",
] as const satisfies readonly LegislationUrlBearingField[];

export type LegislationUrlField = (typeof LEGISLATION_URL_FIELDS)[number];

export type LegislationUrlPolicyOutcome =
  /** Every URL passed; the document carries them in their validated form. */
  | { type: "allowed"; document: LegislationDocumentInput }
  /**
   * One URL named a host the adapter did not declare. The document is not
   * stored: a refused URL is a permanent property of that publisher payload,
   * so it is reported and dropped rather than retried forever (one poison
   * record must not stall a source).
   */
  | { type: "refused"; field: LegislationUrlField; rawUrl: string };

type RestrictLegislationDocumentUrlsOptions = {
  document: LegislationDocumentInput;
  hostPolicy: OutboundHostPolicy;
};

/**
 * Check every URL a document carries against the adapter's declared origins,
 * returning the document with each URL in the exact form the check validated.
 */
export const restrictLegislationDocumentUrls = ({
  document,
  hostPolicy,
}: RestrictLegislationDocumentUrlsOptions): LegislationUrlPolicyOutcome => {
  const restricted: Partial<Record<LegislationUrlField, string>> = {};
  for (const field of LEGISLATION_URL_FIELDS) {
    const rawUrl = document[field];
    if (rawUrl === null || rawUrl === undefined) {
      continue;
    }
    const url = restrictOutboundUrl({ hostPolicy, rawUrl });
    if (url === null) {
      return { type: "refused", field, rawUrl };
    }
    restricted[field] = url.href;
  }
  return { type: "allowed", document: { ...document, ...restricted } };
};

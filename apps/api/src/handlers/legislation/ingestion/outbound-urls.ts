import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import type { OutboundHostPolicy } from "@/api/lib/restrict-outbound-url";

/**
 * The URL boundary for legislation ingestion (case-law rule 21).
 *
 * A URL arriving in a publisher's HTML or JSON is untrusted input, and a
 * stored one is a future fetch target. Checking it here — in the runner, over
 * every URL-bearing field of every document a page returns — is what makes
 * the guarantee hold for adapters nobody has written yet.
 *
 * A refused URL nulls its own field and nothing else. The document's
 * identity, text and payload are unrelated to the link, and a statute that
 * one off-policy URL made unreachable would be a permanent hole in a
 * forward-only crawl.
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

/** Why a URL was refused, to the extent this boundary observes it itself. */
export const URL_REFUSAL_REASON = {
  /** Not a URL. */
  UNPARSEABLE: "unparseable",
  /** Carries userinfo. */
  CREDENTIALS: "credentials",
  /** Carries a fragment; a stored URL addresses a document. */
  FRAGMENT: "fragment",
  /** Declined on host, scheme or length. */
  POLICY: "policy",
} as const;

export type UrlRefusalReason =
  (typeof URL_REFUSAL_REASON)[keyof typeof URL_REFUSAL_REASON];

/**
 * A refused URL reduced to what is safe to record. The raw value never leaves
 * this module: a publisher can hand back userinfo or a signed query, and a
 * refusal must not turn a credential into a log entry.
 */
export type LegislationUrlRefusal = {
  field: LegislationUrlField;
  /** Hostname, `none` for a scheme without one, `unparseable` for a non-URL. */
  host: string;
  reason: UrlRefusalReason;
};

export type LegislationUrlPolicyOutcome = {
  /** The document, with every refused field nulled and the rest validated. */
  document: LegislationDocumentInput;
  /** One entry per nulled field. */
  refusals: LegislationUrlRefusal[];
};

const refusalOf = (
  field: LegislationUrlField,
  rawUrl: string,
): LegislationUrlRefusal => {
  const url = URL.parse(rawUrl);
  if (url === null) {
    return {
      field,
      host: "unparseable",
      reason: URL_REFUSAL_REASON.UNPARSEABLE,
    };
  }
  const host = url.hostname === "" ? "none" : url.hostname;
  if (url.username !== "" || url.password !== "") {
    return { field, host, reason: URL_REFUSAL_REASON.CREDENTIALS };
  }
  if (url.hash !== "") {
    return { field, host, reason: URL_REFUSAL_REASON.FRAGMENT };
  }
  return { field, host, reason: URL_REFUSAL_REASON.POLICY };
};

type RestrictLegislationDocumentUrlsOptions = {
  document: LegislationDocumentInput;
  hostPolicy: OutboundHostPolicy;
};

/**
 * Check every URL a document carries against the adapter's declared origins.
 * A URL that passes is kept in the exact form the check validated; one that
 * does not is replaced with null and reported as a redacted refusal.
 */
export const restrictLegislationDocumentUrls = ({
  document,
  hostPolicy,
}: RestrictLegislationDocumentUrlsOptions): LegislationUrlPolicyOutcome => {
  const applied: Partial<Record<LegislationUrlField, string | null>> = {};
  const refusals: LegislationUrlRefusal[] = [];
  for (const field of LEGISLATION_URL_FIELDS) {
    const rawUrl = document[field];
    if (rawUrl === null || rawUrl === undefined) {
      continue;
    }
    const url = restrictOutboundUrl({ hostPolicy, rawUrl });
    if (url === null) {
      applied[field] = null;
      refusals.push(refusalOf(field, rawUrl));
      continue;
    }
    applied[field] = url.href;
  }
  return { document: { ...document, ...applied }, refusals };
};

import type { Result } from "better-result";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import type { SafeId } from "@/api/lib/branded-types";
import type { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import type {
  ReconciliationUnsupported,
  SliceCoverage,
  SourceSliceWalk,
  SourceTotalCount,
} from "@/api/lib/legal-search/ingestion-types";
import type { OutboundHostPolicy } from "@/api/lib/restrict-outbound-url";

/**
 * The legislation half of the ingestion contract, mirroring `SourceAdapter`
 * in `ingestion-types.ts`.
 *
 * Everything genuinely shared is imported from there rather than restated:
 * the fetch error, the count answer, the reconciliation marker, the
 * slice-walk conventions and the coverage triple mean the same thing to both
 * families, and two copies of one rule drift silently.
 *
 * What is not shared is the payload. A statute row is one Expression of a
 * Work, keyed `(source, eli, version, language)`; a decision row is keyed by
 * the publisher's document id. Those identities have nothing in common, so
 * `LegislationDocumentInput` stands apart from `IngestionResult` instead of
 * being generalised into it.
 */

/** Lifecycle of a legislative text at a given point in time. */
export type LegislationStatus = "current" | "historical" | "repealed" | "draft";

/** Normalized legislation document — what every source produces. */
export type LegislationDocumentInput = {
  /**
   * The source row this document belongs to. Stamped by
   * `runLegislationIngestion`, which holds it: whatever an adapter sets is
   * overwritten, so no adapter needs to recover it from its config.
   */
  sourceId: SafeId<"legislationSource">;
  /** Work identifier (ELI / national statute id), shared across versions. */
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType?: string | null;
  status?: LegislationStatus;
  effectiveDate?: string | null;
  /** Point-in-time consolidation window; null versionValidTo = current. */
  versionValidFrom?: string | null;
  versionValidTo?: string | null;
  fulltext?: string | null;
  sections?: DecisionSection[] | null;
  ast?: DocumentAst | EmptyAst | null;
  sourceUrl?: string | null;
  documentUrl?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * The publisher's response verbatim (HTML, a JSON string, a structured
   * envelope over several responses), stored so a later parser can be
   * replayed without re-crawling. Case-law rule 3 applies unchanged: a
   * parser improvement is free while this is kept and needs a fresh crawl of
   * a publisher that may have moved once it is not.
   *
   * Optional only for a source that publishes no retrievable payload; every
   * adapter that fetches one sets it.
   */
  sourceRaw?: string | undefined;
  /** MIME type recorded with `sourceRaw` in object storage. */
  sourceRawContentType?: string | undefined;
  /**
   * The adapter's fingerprint of this observation, folded into the row's
   * dedup hash.
   *
   * Required, because it is the only field that can tell "the publisher
   * re-served the same bytes" from "the publisher changed something this
   * parser does not yet read". Without it a source whose payload gained a
   * field the parser ignores hashes identically forever, and the row can
   * never be refreshed once the parser learns to read it.
   */
  rawHash: string;
};

/**
 * A page of legislation documents plus the cursor that follows it.
 *
 * Cursor conventions are the case-law ones (`ingestion-types.ts`, and rules
 * 13-14 and 19 of the case-law guide): `null` means the source restarts from
 * scratch, so an exhausted walk parks at a bounded recent position instead,
 * and a full page with no continuation token is a failure rather than an
 * ending.
 */
export type LegislationSyncPage = {
  documents: LegislationDocumentInput[];
  nextCursor: string | null;
  /**
   * What the source itself says the slice this page completes holds, against
   * what was collected for it. Omitted by a publisher that states no count;
   * that is a recorded blind spot rather than a silent one.
   */
  coverage?: SliceCoverage | undefined;
};

/**
 * The legislation slice-walk capability: the publisher can be addressed slice
 * by slice, independently of the cursor the crawl advanced.
 *
 * Deliberately only the walk. Case law pairs it with an item-level listing
 * (`listSlicePage` / `buildDecision`) because a decision is reconciled one
 * publisher identity at a time; a statute is reconciled per Work by counting
 * its Expressions, which is a census rather than a listing and does not exist
 * yet. Declaring the walk alone is what an adapter can honestly promise
 * today, and it is exactly what `tipWindowSlices` consumes.
 */
export type LegislationSourceReconciliation = SourceSliceWalk;

/**
 * Every legislation source that may be registered.
 *
 * Empty: no adapter exists yet. Adding a key here is a compile error until
 * its adapter is registered, because the registry is a total
 * `Record<LegislationAdapterKey, …>` — and that ordering is the point: the
 * key is the declaration that a source exists, and a declared source with no
 * adapter is one the runner looks up and does not find.
 *
 * An array rather than case law's named-constant object, for the same reason
 * `CASE_LAW_JURISDICTIONS` is one: at zero members `Object.values` over an
 * empty `as const` object has no useful element type, while `[number]` over
 * an empty tuple is `never`, which is the truth.
 */
export const LEGISLATION_ADAPTER_KEYS = [] as const;

export type LegislationAdapterKey = (typeof LEGISLATION_ADAPTER_KEYS)[number];

/**
 * Interface for legislation data source adapters.
 *
 * Each adapter knows how to paginate through one publisher and parse its
 * consolidations into `LegislationDocumentInput`.
 *
 * No `country` / `language` field, unlike `SourceAdapter`: case law carries
 * them because per-jurisdiction policy maps are keyed off the adapter, and
 * legislation has no such map. A source may also publish for more than one
 * language, so the document states both and the adapter states neither.
 */
export type LegislationSourceAdapter = {
  /**
   * The `legislation_sources.adapter_key` this adapter serves.
   *
   * `string` rather than `LegislationAdapterKey`, unlike `SourceAdapter`:
   * that union is empty until the first key is declared, which would make
   * this whole contract uninhabitable and untestable before an adapter
   * exists. Nothing is lost — the registry's mapped type is what binds a key
   * to its slot, so a registered adapter still cannot carry a key other than
   * the one it is registered under.
   */
  key: string;
  name: string;
  /**
   * The origins this publisher's documents may name.
   *
   * Declared as data because the check is applied by the runner over every
   * URL a page returns (case-law rule 21), not by each adapter: a guard every
   * adapter has to remember to call is a guard one adapter will not call.
   */
  outboundHostPolicy: OutboundHostPolicy;
  fetchPage: (
    cursor: string | null,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Result<LegislationSyncPage, AdapterFetchError>>;
  /** Minimum ms between requests to respect rate limits. */
  minRequestIntervalMs: number;
  /** Override per-page timeout (ms). Defaults to ADAPTER_TIMEOUT.PAGE. */
  pageTimeoutMs?: number | undefined;
  /**
   * Max pages per pipeline cycle. Shorter cycles persist cursors more often,
   * reducing lost work on interruptions. Defaults to MAX_SYNC_PAGES (100).
   */
  maxSyncPages?: number | undefined;
  /**
   * Override per-adapter cycle timeout (ms). Defaults to MAX_CYCLE_MS
   * (10 min).
   */
  maxCycleMs?: number | undefined;
  /**
   * Ask the source how much legislation it holds, so held-vs-total coverage
   * has a denominator the publisher itself states.
   *
   * Required: a source nobody can count is a source whose coverage nobody can
   * report, and that has to be a stated property of the adapter rather than a
   * field somebody forgot.
   */
  getTotalCount: (signal: AbortSignal) => Promise<SourceTotalCount>;
  /**
   * How this source's history divides into slices the census can address,
   * or `ReconciliationUnsupported` where a forward-only cursor is the only
   * way to reach a document.
   *
   * Required, and answerable with the unsupported marker: an omitted field is
   * a decision nobody made, while the marker is a decision written down with
   * its reason.
   */
  reconciliation: LegislationSourceReconciliation | ReconciliationUnsupported;
};

/** Preserve an adapter's literal registry key while contextualizing its API. */
export const defineLegislationAdapter = <const TKey extends string>(
  adapter: LegislationSourceAdapter & { readonly key: TKey },
): LegislationSourceAdapter & { readonly key: TKey } => adapter;

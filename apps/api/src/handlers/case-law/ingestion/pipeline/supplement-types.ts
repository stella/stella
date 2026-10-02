import type { ScopedDb } from "@/api/db/safe-db";
import type {
  DecisionSupplement,
  SourceAdapter,
  StoredRawResultReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type {
  PROCESS_DECISION_STATUS,
  PROCESS_DECISION_RETRY_REASON,
  SUPPLEMENT_RETRY_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import type { absorbStandaloneSupplementRow } from "@/api/handlers/case-law/ingestion/supplement-absorption";
import type { RuleCache } from "@/api/handlers/case-law/polarity/rule-engine";
import type { SafeId } from "@/api/lib/branded-types";

/** Emitted when a supplement's judgment could not be rebuilt to compose it. */
export const SUPPLEMENT_JUDGMENT_UNREADABLE =
  "case_law.ingestion.supplement_judgment_unreadable";

/** Emitted when a supplement's judgment payload could not be read this time. */
export const SUPPLEMENT_JUDGMENT_READ_FAILED =
  "case_law.ingestion.supplement_judgment_read_failed";

/** Why a supplement is kept as a decision of its own. */
export const SUPPLEMENT_STANDALONE_REASON = {
  /** No stored ruling under its docket can be its judgment. */
  NO_JUDGMENT: "no-judgment",
  /** Several stored rulings could be; attaching to one would be a guess. */
  AMBIGUOUS: "ambiguous",
  /** The judgment's stored payload could not be rebuilt to compose it. */
  JUDGMENT_UNREADABLE: "judgment-unreadable",
  /** The judgment holds no document of its own to compose it into yet. */
  JUDGMENT_WITHOUT_DOCUMENT: "judgment-without-document",
} as const;

export type SupplementStandaloneReason =
  (typeof SUPPLEMENT_STANDALONE_REASON)[keyof typeof SUPPLEMENT_STANDALONE_REASON];

/** What became of one supplement. */
export type SupplementDisposition =
  /** Its judgment's stored document holds this version of it. */
  | { type: "merged"; judgmentId: SafeId<"caseLawDecision"> }
  /**
   * Parked, and kept readable as a decision of its own until its judgment
   * arrives: that judgment's write composes it and absorbs the row.
   */
  | { type: "standalone"; reason: SupplementStandaloneReason }
  /**
   * Its judgment is redacted. A takedown covers the reasons of the decision
   * it took down, so the supplement is parked, nothing is published, and a
   * standalone row it already has is absorbed into the judgment.
   */
  | { type: "withheld"; judgmentId: SafeId<"caseLawDecision"> }
  /**
   * Its own standalone row is erased. The erasure covers the supplement, so
   * nothing of it is kept or placed.
   */
  | { type: "erased"; decisionId: SafeId<"caseLawDecision"> };

export type ProcessSupplementResult =
  | {
      status: typeof PROCESS_DECISION_STATUS.COMPLETE;
      disposition: SupplementDisposition;
    }
  | {
      status: typeof PROCESS_DECISION_STATUS.RETRYABLE;
      reason:
        | (typeof PROCESS_DECISION_RETRY_REASON)[keyof typeof PROCESS_DECISION_RETRY_REASON]
        | (typeof SUPPLEMENT_RETRY_REASON)[keyof typeof SUPPLEMENT_RETRY_REASON];
    };

export type ProcessSupplementOptions = {
  supplement: DecisionSupplement;
  sourceId: SafeId<"caseLawSource">;
  scopedDb: ScopedDb;
  observedAt: Date;
  /**
   * The next observation order on the source's counter, under the lease the
   * caller holds. A supplement writes its judgment again, and possibly in the
   * page that just wrote it, so it cannot reuse the page's order: the row
   * guard would read the rewrite as stale.
   */
  nextObservationOrder: () => Promise<bigint>;
  /** Rebuilds the judgment from its stored payload: the adapter's replay. */
  reparseStoredRaw: NonNullable<SourceAdapter["reparseStoredRaw"]>;
  readStoredRaw: StoredRawResultReader;
  corpus?: CaseLawCorpusDependencies;
  polarityRules?: RuleCache | undefined;
  /** Test seam; production absorbs through the corpus stores. */
  absorb?: typeof absorbStandaloneSupplementRow;
};

import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import type { COURT_TIER_WEIGHT } from "@stll/ui/document-identity-badge.logic";
import { CaseLawIcon, SearchIcon } from "@stll/ui/icons";
import { SEARCH_HIT_MARK, TextMark } from "@stll/ui/text-mark";

import { formatPreviewDate } from "./format";
import { FeaturePreviewSurface } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type ResearchPreviewLabels = {
  /** Title of the case-law search surface. */
  caseLaw: string;
};

export type ResearchPreviewDecision = {
  court: {
    name: string;
    /** Badge text (`NS`, `ÚS`). */
    abbreviation: string;
    /** Badge weight, from solid (constitutional) to dashed (other). */
    tier: keyof typeof COURT_TIER_WEIGHT;
  };
  /** `YYYY-MM-DD`. */
  date: string;
  /** Unique within the results. */
  fileNumber: string;
  /** The matched passage: `hit` is highlighted between `before` and
   *  `after`. */
  before: string;
  hit: string;
  after: string;
};

export type ResearchPreviewData = {
  query: string;
  decisions: readonly ResearchPreviewDecision[];
};

/** Case-law search: a query and the decisions it found, each with its court,
 *  date, file number and the passage that matched. */
export const ResearchPreview = ({
  labels,
  locale,
  data = DEFAULT_DATA,
  className,
}: FeaturePreviewProps<ResearchPreviewLabels, ResearchPreviewData>) => (
  <FeaturePreviewSurface
    className={className}
    icon={<CaseLawIcon className="text-muted-foreground size-4 shrink-0" />}
    title={labels.caseLaw}
  >
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="bg-card flex h-9 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm shadow-xs">
        <SearchIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{data.query}</span>
      </div>
      <ol className="flex min-h-0 flex-col divide-y">
        {data.decisions.map((decision) => (
          <li className="flex flex-col gap-1 py-2.5" key={decision.fileNumber}>
            <div className="flex min-w-0 items-center gap-2">
              <DocumentIdentityBadge
                identity={{
                  kind: "decision",
                  courtAbbreviation: decision.court.abbreviation,
                  courtTier: decision.court.tier,
                }}
              />
              <span className="truncate text-sm font-medium">
                {decision.court.name}
              </span>
              <span className="text-muted-foreground ms-auto shrink-0 whitespace-nowrap tabular-nums">
                {formatPreviewDate({
                  locale,
                  date: decision.date,
                  options: { day: "numeric", month: "short", year: "numeric" },
                })}
              </span>
            </div>
            <bdi className="text-muted-foreground text-2xs font-mono">
              {decision.fileNumber}
            </bdi>
            <p className="text-foreground-strong-muted line-clamp-2 leading-relaxed">
              {decision.before}
              <TextMark {...SEARCH_HIT_MARK}>{decision.hit}</TextMark>
              {decision.after}
            </p>
          </li>
        ))}
      </ol>
    </div>
  </FeaturePreviewSurface>
);

// The default content; see `mock-data.ts`. The decisions are invented for
// the illustration.
const DEFAULT_DATA = {
  query: "limitation period for warranty claims under a share purchase",
  decisions: [
    {
      court: {
        name: "Supreme Court",
        abbreviation: "NS",
        tier: "supreme",
      },
      date: "2025-03-18",
      fileNumber: "27 Cdo 1931/2024",
      before: "For a claim under a share purchase agreement, the ",
      hit: "limitation period",
      after:
        " begins when the buyer learned of the breach of warranty, not on the day of completion.",
    },
    {
      court: {
        name: "Constitutional Court",
        abbreviation: "ÚS",
        tier: "constitutional",
      },
      date: "2024-06-04",
      fileNumber: "II. ÚS 1187/23",
      before: "A court that applies the ",
      hit: "limitation period",
      after:
        " without asking when the claimant could know of the defect denies a fair hearing.",
    },
    {
      court: {
        name: "High Court in Prague",
        abbreviation: "VS",
        tier: "regional",
      },
      date: "2023-11-29",
      fileNumber: "5 Cmo 112/2023",
      before: "Contractual caps on ",
      hit: "warranty claims",
      after:
        " do not shorten the statutory limitation period unless the parties say so expressly.",
    },
  ],
} as const satisfies ResearchPreviewData;

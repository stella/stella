import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import type { DocumentIdentity } from "@stll/ui/document-identity-badge.logic";
import { CaseLawIcon, SearchIcon } from "@stll/ui/icons";
import { SEARCH_HIT_MARK, TextMark } from "@stll/ui/text-mark";

import { formatPreviewDate } from "./format";
import { FeaturePreviewSurface } from "./surface";
import type { FeaturePreviewProps } from "./surface";

export type ResearchPreviewLabels = {
  /** Title of the case-law search surface. */
  caseLaw: string;
};

/** Case-law search: a query and the decisions it found, each with its court,
 *  date, file number and the passage that matched. */
export const ResearchPreview = ({
  labels,
  locale,
  className,
}: FeaturePreviewProps<ResearchPreviewLabels>) => (
  <FeaturePreviewSurface
    className={className}
    icon={<CaseLawIcon className="text-muted-foreground size-4 shrink-0" />}
    title={labels.caseLaw}
  >
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="bg-card flex h-9 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm shadow-xs">
        <SearchIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{QUERY}</span>
      </div>
      <ol className="flex min-h-0 flex-col divide-y">
        {DECISIONS.map((decision) => (
          <li className="flex flex-col gap-1 py-2.5" key={decision.fileNumber}>
            <div className="flex min-w-0 items-center gap-2">
              <DocumentIdentityBadge identity={decision.court.identity} />
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

type PreviewDecision = {
  court: { name: string; identity: DocumentIdentity };
  date: string;
  fileNumber: string;
  before: string;
  hit: string;
  after: string;
};

// Mock content depicting user data, not interface text; deliberately
// untranslated. The decisions are invented for the illustration.
const QUERY = "limitation period for warranty claims under a share purchase";

const DECISIONS: readonly PreviewDecision[] = [
  {
    court: {
      name: "Supreme Court",
      identity: {
        kind: "decision",
        courtAbbreviation: "NS",
        courtTier: "supreme",
      },
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
      identity: {
        kind: "decision",
        courtAbbreviation: "ÚS",
        courtTier: "constitutional",
      },
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
      identity: {
        kind: "decision",
        courtAbbreviation: "VS",
        courtTier: "regional",
      },
    },
    date: "2023-11-29",
    fileNumber: "5 Cmo 112/2023",
    before: "Contractual caps on ",
    hit: "warranty claims",
    after:
      " do not shorten the statutory limitation period unless the parties say so expressly.",
  },
];

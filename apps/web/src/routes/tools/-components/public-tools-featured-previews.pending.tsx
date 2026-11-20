import type { ReactNode } from "react";

import { Building2Icon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { PendingText, type PendingTextKey } from "@/components/pending-text";

const REVIEW_EXAMPLES = [
  {
    label: "publicTools.discovery.review.liabilityCap",
    status: "publicTools.discovery.review.outsidePlaybook",
    toneClassName: "text-warning-foreground",
  },
  {
    label: "publicTools.discovery.review.termination",
    status: "publicTools.discovery.review.aligned",
    toneClassName: "text-success",
  },
  {
    label: "publicTools.discovery.review.governingLaw",
    status: "publicTools.discovery.review.missing",
    toneClassName: "text-warning-foreground",
  },
] as const;

const RANK_EXAMPLE = [
  { rank: "1", width: "w-full" },
  { rank: "2", width: "w-4/5" },
  { rank: "3", width: "w-3/5" },
];

const PreviewFrame = ({
  children,
  label = "common.preview",
}: {
  children: ReactNode;
  label?: PendingTextKey;
}) => (
  <div className="bg-background/75 self-stretch rounded-xl p-4 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.025)]">
    <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
      <PendingText id={label} />
    </p>
    {children}
  </div>
);

export const ContractReviewPreview = () => (
  <PreviewFrame label="publicTools.discovery.exampleReview">
    <div className="flex flex-col gap-2">
      {REVIEW_EXAMPLES.map(({ label, status, toneClassName }) => (
        <div
          className="bg-muted/45 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
          key={label}
        >
          <span className="text-foreground text-xs font-medium">
            <PendingText id={label} />
          </span>
          <span className={cn(toneClassName, "text-xs")}>
            <PendingText id={status} />
          </span>
        </div>
      ))}
    </div>
  </PreviewFrame>
);

export const CaseLawPreview = () => (
  <PreviewFrame>
    <div aria-hidden="true" className="flex flex-col gap-2.5">
      {RANK_EXAMPLE.map(({ rank, width }) => (
        <div className="flex items-center gap-2.5" key={rank}>
          <span className="text-muted-foreground w-4 text-xs tabular-nums">
            {rank}
          </span>
          <span className={cn("bg-foreground/10 h-2 rounded-full", width)} />
        </div>
      ))}
    </div>
  </PreviewFrame>
);

export const CompanyRegistryPreview = ({
  jurisdictions,
}: {
  jurisdictions: readonly string[];
}) => (
  <PreviewFrame>
    <div aria-hidden="true" className="flex items-center gap-3">
      <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
        <Building2Icon className="text-muted-foreground size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="bg-foreground/10 h-2 w-3/4 rounded-full" />
        <span className="bg-foreground/5 h-2 w-1/2 rounded-full" />
      </div>
      {jurisdictions.map((code) => (
        <span
          className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
          key={code}
        >
          <bdi>{code}</bdi>
        </span>
      ))}
    </div>
  </PreviewFrame>
);

import { panic } from "better-result";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";
import { CourtBadge } from "@stll/ui/court-badge";
import { BookTextIcon, FileTextIcon } from "@stll/ui/icons";

import { CourtTierBadge } from "@/features/case-law/components/court-name";

type DocumentIdentityBadgeProps = {
  identity:
    | {
        kind: "decision";
        courtAbbreviation: string | null | undefined;
        courtTier?: CourtTierLabel | undefined;
      }
    | { kind: "statute"; number: string | null; year: string | null }
    | { kind: "unknown" };
  title?: string;
};

// Temporary recents adapter; the shared UI badge takes this same contract.
export const DocumentIdentityBadge = ({
  identity,
  title,
}: DocumentIdentityBadgeProps) => {
  switch (identity.kind) {
    case "unknown":
      return <FileTextIcon className="size-4" />;
    case "decision":
      if (!identity.courtAbbreviation) {
        return <FileTextIcon className="size-4" />;
      }
      return (
        <span title={title}>
          {identity.courtTier === undefined ? (
            <CourtBadge
              abbreviation={identity.courtAbbreviation}
              weight="outline"
            />
          ) : (
            <CourtTierBadge
              abbreviation={identity.courtAbbreviation}
              tier={identity.courtTier}
            />
          )}
        </span>
      );
    case "statute":
      if (identity.number === null || identity.year === null) {
        return <BookTextIcon className="size-4" />;
      }
      return (
        <span className="inline-flex items-center gap-1" title={title}>
          <BookTextIcon className="size-4" />
          <bdi>
            {identity.number}/{identity.year.slice(-2)}
          </bdi>
        </span>
      );
    default:
      identity satisfies never;
      return panic("Unhandled document identity kind");
  }
};

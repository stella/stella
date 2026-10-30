import { panic } from "better-result";

import { FileTextIcon } from "../icons";
import { cn } from "../lib/utils";
import { CourtBadge } from "./court-badge";
import type { CourtBadgeSize } from "./court-badge";
import {
  caseNumberIdentityLabels,
  COURT_TIER_WEIGHT,
  statuteIdentityLabels,
} from "./document-identity-badge.logic";
import type {
  DocumentIdentity,
  IdentityLabels,
} from "./document-identity-badge.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export const DocumentIdentityBadge = ({
  identity,
  size,
  title,
}: DocumentIdentityBadgeProps) => {
  const content = documentIdentityMark(identity, size);
  if (title === undefined) {
    return content;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex max-w-full min-w-0" />}
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup>{title}</TooltipPopup>
    </Tooltip>
  );
};

type DocumentIdentityBadgeProps = {
  identity: DocumentIdentity;
  /** Court chip size; statute labels follow their container width. */
  size?: CourtBadgeSize | undefined;
  /** Omit when the enclosing tab already supplies the full-title tooltip. */
  title?: string | undefined;
};

function documentIdentityMark(
  identity: DocumentIdentity,
  size: CourtBadgeSize | undefined,
) {
  switch (identity.kind) {
    case "statute": {
      const labels = statuteIdentityLabels(identity);
      return labels === null
        ? unknownDocumentMark()
        : referenceLabelMark(labels, "statute");
    }
    case "caseNumber": {
      const labels = caseNumberIdentityLabels(identity);
      return labels === null
        ? unknownDocumentMark()
        : referenceLabelMark(labels, "caseNumber");
    }
    case "decision": {
      const abbreviation = identity.courtAbbreviation?.trim();
      if (!abbreviation) {
        return unknownDocumentMark();
      }
      return (
        <span
          className="inline-flex max-w-full min-w-0"
          data-slot="document-identity-badge"
          data-kind="decision"
        >
          <CourtBadge
            abbreviation={abbreviation}
            size={size}
            weight={
              identity.courtTier === undefined
                ? "outline"
                : COURT_TIER_WEIGHT[identity.courtTier]
            }
            className={cn(
              "max-w-full overflow-hidden",
              abbreviation.length > 4 && "px-0.5 text-[9px] tracking-normal",
            )}
          />
        </span>
      );
    }
    case "unknown":
      return unknownDocumentMark();
    default:
      identity satisfies never;
      return panic("Unhandled document identity");
  }
}

/**
 * A number standing for its document: a statute's `165/12`, a decision's
 * `C-359/25`. Container queries compare available space with the full label
 * in the same monospace units, so no observer or per-row state is needed; a
 * label longer than its slot even in the short form truncates rather than
 * spilling over its neighbour.
 */
function referenceLabelMark(
  labels: IdentityLabels,
  kind: "caseNumber" | "statute",
) {
  const classes = statuteLabelClasses(labels.long.length);
  return (
    <span
      className={cn(
        "@container/document-identity inline-flex max-w-full shrink-0 items-center justify-center font-mono leading-4 font-semibold tabular-nums",
        labels.short.length > 7 ? "text-[9px]" : "text-[10px]",
      )}
      style={{ width: `${labels.long.length + 0.25}ch` }}
      data-slot="document-identity-badge"
      data-kind={kind}
      dir="ltr"
    >
      <bdi className={cn("min-w-0 truncate", classes.short)}>
        {labels.short}
      </bdi>
      <bdi className={cn("min-w-0 truncate", classes.long)}>{labels.long}</bdi>
    </span>
  );
}

function unknownDocumentMark() {
  return (
    <FileTextIcon
      aria-hidden="true"
      className="size-3.5 shrink-0"
      data-slot="document-identity-badge"
      data-kind="unknown"
    />
  );
}

// Gazette numbers contain at most five digits. These query classes stay
// literal so every app's Tailwind scan includes both width variants.
const STATUTE_LABEL_CLASSES = {
  6: {
    short: "@[6ch]/document-identity:hidden",
    long: "hidden @[6ch]/document-identity:inline",
  },
  7: {
    short: "@[7ch]/document-identity:hidden",
    long: "hidden @[7ch]/document-identity:inline",
  },
  8: {
    short: "@[8ch]/document-identity:hidden",
    long: "hidden @[8ch]/document-identity:inline",
  },
  9: {
    short: "@[9ch]/document-identity:hidden",
    long: "hidden @[9ch]/document-identity:inline",
  },
  10: {
    short: "@[10ch]/document-identity:hidden",
    long: "hidden @[10ch]/document-identity:inline",
  },
} as const;

function statuteLabelClasses(length: number) {
  if (length <= 6) {
    return STATUTE_LABEL_CLASSES[6];
  }
  if (length === 7) {
    return STATUTE_LABEL_CLASSES[7];
  }
  if (length === 8) {
    return STATUTE_LABEL_CLASSES[8];
  }
  if (length === 9) {
    return STATUTE_LABEL_CLASSES[9];
  }
  return STATUTE_LABEL_CLASSES[10];
}

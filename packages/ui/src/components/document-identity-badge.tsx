import { panic } from "better-result";

import { FileTextIcon } from "../icons";
import { cn } from "../lib/utils";
import { CourtBadge } from "./court-badge";
import {
  COURT_TIER_WEIGHT,
  statuteIdentityLabels,
} from "./document-identity-badge.logic";
import type { DocumentIdentity } from "./document-identity-badge.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export const DocumentIdentityBadge = ({
  identity,
  title,
}: DocumentIdentityBadgeProps) => {
  const content = documentIdentityMark(identity);
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
  /** Omit when the enclosing tab already supplies the full-title tooltip. */
  title?: string | undefined;
};

function documentIdentityMark(identity: DocumentIdentity) {
  switch (identity.kind) {
    case "statute": {
      const labels = statuteIdentityLabels(identity);
      if (labels === null) {
        return unknownDocumentMark();
      }
      // Container queries compare available space with the full label
      // in the same monospace units; no observer or per-row state is needed.
      return (
        <span
          className={cn(
            "@container/document-identity inline-flex max-w-full shrink-0 items-center justify-center font-mono leading-4 font-semibold tabular-nums",
            labels.short.length > 7 ? "text-[9px]" : "text-[10px]",
          )}
          style={{ width: `${labels.long.length + 0.25}ch` }}
          data-slot="document-identity-badge"
          data-kind="statute"
          dir="ltr"
        >
          <bdi className={statuteLabelClasses(labels.long.length).short}>
            {labels.short}
          </bdi>
          <bdi className={statuteLabelClasses(labels.long.length).long}>
            {labels.long}
          </bdi>
        </span>
      );
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

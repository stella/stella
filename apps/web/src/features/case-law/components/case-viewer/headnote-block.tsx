import { useState } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import { SparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { CourtTierBadge } from "@/features/case-law/components/court-name";
import type { CourtTier } from "@/features/case-law/decision-filter-facets.logic";

/** The court's own chip, where the registry abbreviates it. */
type CourtChip = { abbreviation: string; tier: CourtTier };

/**
 * Who wrote a block of top matter.
 *
 * The court's headnote and the model's are drawn the same way — same
 * typography, same label, same fold — so the mark is the only thing that
 * separates them, and every block carries one. A discriminator rather than an
 * `isAi` flag: the next origin a decision gains is a branch here, not a second
 * boolean that can be set with the first.
 */
export type HeadnoteOrigin =
  | { type: "ai" }
  | { type: "court"; chip: CourtChip | null };

/**
 * The mark itself. The court's chip stands beside the court's name, which the
 * reference line above the top matter already prints; where nothing
 * abbreviates the court, the mark says "court" in words rather than inventing
 * a chip for it.
 */
const OriginMark = ({ origin }: { origin: HeadnoteOrigin }) => {
  const t = useTranslations();

  switch (origin.type) {
    case "ai":
      return (
        <span className="inline-flex items-center gap-1 align-middle">
          <SparklesIcon aria-hidden className="size-3" />
          {t("caseLaw.notesFilter.ai")}
        </span>
      );
    case "court":
      return origin.chip === null ? (
        <span className="align-middle">{t("common.court")}</span>
      ) : (
        <CourtTierBadge
          abbreviation={origin.chip.abbreviation}
          className="align-middle"
          tier={origin.chip.tier}
        />
      );
    default:
      origin satisfies never;
      return panic(`Unhandled headnote origin: ${String(origin)}`);
  }
};

type HeadnoteBlockProps = {
  children: ReactNode;
  /** Whether the section opens with the page, before the reader touches it. */
  defaultOpen: boolean;
  /** Held open while what the reader is looking for sits inside it. */
  forceOpen?: boolean | undefined;
  /** The section's name — the same words whoever wrote the text under it. */
  label: string;
  origin: HeadnoteOrigin;
};

/**
 * One named section of a decision's top matter: a headnote or an abstract,
 * under its own label and its own origin mark.
 *
 * The body inherits the article's serif, size and line-height, so the text
 * reads as part of the decision whoever wrote it; only the label is chrome.
 * Text the court did not write is marked `data-reader-chrome` and carries no
 * `data-anchor`, so it can be neither highlighted, cited, nor pulled into a
 * quotation of the passage beside it.
 */
export const HeadnoteBlock = ({
  children,
  defaultOpen,
  forceOpen = false,
  label,
  origin,
}: HeadnoteBlockProps) => {
  // The default is the same on the server and on the client, so the first
  // paint is the final one.
  const [openedByReader, setOpenedByReader] = useState(defaultOpen);

  return (
    <details
      className="mt-4 first:mt-0"
      data-reader-chrome={origin.type === "court" ? undefined : ""}
      onToggle={(event) => {
        // Held open by a find match, not by the reader: recording it as their
        // choice would leave the section open once the match moves on.
        if (forceOpen) {
          return;
        }
        setOpenedByReader(event.currentTarget.open);
      }}
      open={openedByReader || forceOpen}
    >
      <summary
        className="reader-chrome text-muted-foreground cursor-pointer text-[calc(0.75rem*var(--reader-text-scale))] font-semibold tracking-wide uppercase select-none marker:text-current"
        data-reader-chrome=""
      >
        {label}
        <span className="text-foreground-disabled ms-2">
          <OriginMark origin={origin} />
        </span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
};

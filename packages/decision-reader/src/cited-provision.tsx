import { useState } from "react";
import type { KeyboardEvent, MouseEventHandler, ReactNode } from "react";

import { panic } from "better-result";

import { statuteListSchemeFor } from "@stll/api-contract/statute-list-schemes";
import { paragraphFromPreview } from "@stll/legal-ast/statute-list";
import type { StatuteListScheme } from "@stll/legal-ast/statute-list";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { LEGAL_TEXT_CLASS_NAME } from "@stll/ui/prose";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { LEGAL_CITATION_LINK_CLASS_NAME } from "./citation-link";
import { BlockRenderer } from "./document-ast-text";
import {
  fullProvisionOutcome,
  informativeProvisionTrail,
  PROVISION_CARD_SCOPE,
  PROVISION_WORDING_EMPHASIS,
  provisionCardLabels,
  provisionCardPassage,
  provisionCardScope,
  provisionWordingRuns,
} from "./provision-card.logic";
import type {
  CitedWording,
  FullProvisionOutcome,
  FullProvisionRead,
  ProvisionCardPassage,
  ProvisionWordingRun,
} from "./provision-card.logic";
import { useReaderAdapters, useReaderMessages } from "./reader-adapters";
import { ReaderInsetBox } from "./reader-inset-box";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
  ProvisionViewPayload,
} from "./reader-types";
import {
  PEEK_ACTION_PRESENCE,
  ReferencePeek,
  ReferencePeekHeader,
  usePeekActionItems,
} from "./reference-peek";
import type { PeekActionPresence, PeekMetaPart } from "./reference-peek";
import type { ReferencePeekTarget } from "./reference-peek.logic";

/** The card a revealed header action belongs to (`PEEK_ACTION_PRESENCE`). */
const PROVISION_CARD_GROUP = "group/provision-card";

type ProvisionCardHeaderProps = {
  /** Whether the actions wait for their card to be pointed at or focused. */
  actionPresence: PeekActionPresence;
  /** What the card is about, e.g. `§ 226 odst. 1`; never shortened. */
  label: string;
  provision: CitedProvisionTarget;
};

/** A provision's actions: the side panel, its act's page, no publisher copy. */
const useProvisionPeekTarget = (
  provision: CitedProvisionTarget,
): ReferencePeekTarget => {
  const { openProvision, provisionPageLink } = useReaderAdapters();
  return {
    kind: "provision",
    actions: {
      openInSidePanel: () => openProvision(provision.payload),
      openInStella: provisionPageLink(provision),
      openOriginal: null,
    },
  };
};

/** The provision's facts after its label: the act, then the wording's date. */
const useProvisionHeaderMeta = (
  provision: ProvisionViewPayload,
): PeekMetaPart[] => {
  const messages = useReaderMessages();
  const actText = messages.provisionActText(provision);
  const date = messages.formatValidityDate(provision.versionValidFrom);
  return [
    ...(actText === "" ? [] : [{ part: "act", text: actText }]),
    {
      part: "date",
      text:
        date === null
          ? messages["statutes.wordingVersionUnknown"]
          : messages.provisionEffectiveFrom(date),
    },
  ];
};

/**
 * The header every cited-provision card draws, inline under a paragraph and
 * in the margin: the peek header the citation's own peek draws, naming the
 * provision, the act by number and title and the date the quoted wording
 * took effect, with the provision's actions.
 */
export const ProvisionCardHeader = ({
  actionPresence,
  label,
  provision,
}: ProvisionCardHeaderProps) => (
  <ReferencePeekHeader
    actionPresence={actionPresence}
    actions={usePeekActionItems(useProvisionPeekTarget(provision))}
    kind="provision"
    meta={useProvisionHeaderMeta(provision.payload)}
    primary={label}
  />
);

/**
 * Hides a one-line row whose text does not fit on its line, rather than
 * wrapping it or cutting it off mid-word, and shows it again once the line
 * is wide enough. A callback ref, so the observer lives exactly as long as
 * the row.
 */
const hideWhenClipped = (line: HTMLElement | null) => {
  if (line === null) {
    return undefined;
  }
  const fit = () => {
    line.toggleAttribute("data-clipped", line.scrollWidth > line.clientWidth);
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(line);
  return () => {
    observer.disconnect();
  };
};

/**
 * Where the provision sits (part › chapter › …), on one muted line when it
 * fits there and not at all otherwise: a reader placing a provision needs
 * the whole trail or none of it.
 */
const ProvisionTrailLine = ({
  language,
  trail,
}: {
  language: string | undefined;
  trail: readonly string[];
}) =>
  trail.length === 0 ? null : (
    <span
      className="reader-chrome text-muted-foreground block overflow-hidden text-xs whitespace-nowrap data-clipped:invisible data-clipped:h-0"
      data-slot="provision-card-trail"
      lang={language}
      ref={hideWhenClipped}
    >
      <BidiText as="span">{trail.join(" › ")}</BidiText>
    </span>
  );

const ProvisionWordingSkeleton = () => (
  <span className="flex flex-col gap-1.5" data-slot="provision-card-pending">
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-5/6" />
  </span>
);

const ProvisionTextUnavailable = ({
  scope = "cited",
}: {
  scope?: "cited" | "full";
}) => {
  const messages = useReaderMessages();
  return (
    <span
      className="reader-chrome text-muted-foreground text-xs"
      data-slot={
        scope === "full"
          ? "provision-card-full-unavailable"
          : "provision-card-unavailable"
      }
    >
      {messages["statutes.provisionTextUnavailable"]}
    </span>
  );
};

type ProvisionCardPlacement = "gutter" | "inline";

/** The type size of the analysis notes in the margin. */
const GUTTER_NOTE_TYPE =
  "text-[calc(0.75rem*var(--reader-text-scale))] leading-snug";

/**
 * How the wording reads where the card sits: under a paragraph or in a hover
 * card it is quoted text, in the margin it is one more note and reads like
 * the analysis notes beside it.
 */
const WORDING_TYPE = {
  gutter: cn("reader-chrome text-foreground-placeholder", GUTTER_NOTE_TYPE),
  inline: "reader-body text-foreground text-sm leading-relaxed",
} as const satisfies Record<ProvisionCardPlacement, string>;

/**
 * How much of the passage a card draws: all of it, or, in a folded margin
 * card, its first block alone, so the glimpse ends at the end of a unit of
 * the provision rather than cutting into the first item under it.
 */
type ProvisionWordingExtent = "all" | "glimpse";

/** A quoted provision carries no search of its own. */
const NO_RANGES = {};
const NO_ACTIVE_MATCH = -1;

const WORDING_RUN_CLASS = {
  [PROVISION_WORDING_EMPHASIS.cited]: "border-primary/50 border-s-[3px] ps-2.5",
  [PROVISION_WORDING_EMPHASIS.plain]: undefined,
} as const satisfies Record<
  ProvisionWordingRun["emphasis"],
  string | undefined
>;

type ProvisionWordingProps = {
  blocks: ProvisionPreviewData["blocks"];
  /** Blocks a citation of a part names, marked beside the rest. */
  cited: ReadonlySet<string>;
  extent: ProvisionWordingExtent;
  language: string | null;
  placement: ProvisionCardPlacement;
  /** The cited statute's publisher scheme, which its anchors nest lists in. */
  statuteLists: StatuteListScheme;
};

/**
 * Wording of the cited provision, typeset for where the card sits and set
 * by the statute reader's own paragraph renderer, so a quoted paragraph and
 * its letters nest and hang exactly as they do in the statute.
 */
const ProvisionWording = ({
  blocks,
  cited,
  extent,
  language,
  placement,
  statuteLists,
}: ProvisionWordingProps) => (
  <div
    className={cn(
      LEGAL_TEXT_CLASS_NAME,
      "reader-quote flex flex-col gap-[var(--reader-paragraph-gap)] text-pretty",
      WORDING_TYPE[placement],
    )}
    data-slot="provision-card-wording"
    lang={language ?? undefined}
  >
    {provisionWordingRuns(
      extent === "glimpse" ? blocks.slice(0, 1) : blocks,
      cited,
    ).map((run) => (
      <div
        className={WORDING_RUN_CLASS[run.emphasis]}
        data-cited={
          run.emphasis === PROVISION_WORDING_EMPHASIS.cited ? "" : undefined
        }
        data-slot="provision-card-quote"
        key={run.blocks.at(0)?.id}
      >
        {run.blocks.map((block) => (
          <BlockRenderer
            activeMatchIndex={NO_ACTIVE_MATCH}
            anchorPresentation="quoted"
            block={paragraphFromPreview(block)}
            key={block.id}
            rangesByPieceId={NO_RANGES}
            statuteLists={statuteLists}
            variant="statute"
          />
        ))}
      </div>
    ))}
  </div>
);

const PassageBody = ({
  extent = "all",
  passage,
  placement = "inline",
  statuteLists,
}: {
  extent?: ProvisionWordingExtent;
  passage: ProvisionCardPassage;
  placement?: ProvisionCardPlacement;
  statuteLists: StatuteListScheme;
}) => {
  const messages = useReaderMessages();
  switch (passage.type) {
    case "pending":
      return <ProvisionWordingSkeleton />;
    case "passage":
      return passage.blocks.length === 0 ? (
        <ProvisionTextUnavailable />
      ) : (
        <>
          <ProvisionWording
            blocks={passage.blocks}
            cited={passage.cited}
            extent={extent}
            language={passage.language}
            placement={placement}
            statuteLists={statuteLists}
          />
          {passage.unavailable.map((provisionLabel) => (
            <span
              className="reader-chrome text-muted-foreground block text-xs"
              data-slot="provision-card-unavailable-part"
              key={provisionLabel}
            >
              <BidiText>
                {messages.provisionPartTextUnavailable(provisionLabel)}
              </BidiText>
            </span>
          ))}
        </>
      );
    default:
      passage satisfies never;
      return panic("Unhandled provision card passage");
  }
};

/** Where the provision sits, minus what its label already says. */
const provisionTrail = ({
  label,
  passage,
  wording,
}: {
  label: string;
  passage: ProvisionCardPassage;
  wording: ProvisionPreviewData | null | undefined;
}) =>
  passage.type === "pending" || wording === null || wording === undefined
    ? []
    : informativeProvisionTrail({
        label,
        places: wording.headings.map(({ text }) => text),
      });

export type { FullProvisionRead } from "./provision-card.logic";

/** Keep the cited passage visible while the full read is pending or unavailable. */
const FullProvisionWording = ({
  extent,
  outcome,
  passage,
  placement,
  statuteLists,
  wordings,
}: {
  extent: ProvisionWordingExtent;
  outcome: FullProvisionOutcome;
  passage: ProvisionCardPassage;
  placement: ProvisionCardPlacement;
  statuteLists: StatuteListScheme;
  wordings: readonly CitedWording[];
}) => {
  switch (outcome.type) {
    case "pending":
      return (
        <>
          <PassageBody
            extent={extent}
            passage={passage}
            placement={placement}
            statuteLists={statuteLists}
          />
          <ProvisionWordingSkeleton />
        </>
      );
    case "unavailable":
      return (
        <>
          <PassageBody
            extent={extent}
            passage={passage}
            placement={placement}
            statuteLists={statuteLists}
          />
          <ProvisionTextUnavailable scope="full" />
        </>
      );
    case "text":
      return (
        <PassageBody
          extent={extent}
          passage={provisionCardPassage(wordings, outcome.wording)}
          placement={placement}
          statuteLists={statuteLists}
        />
      );
    default:
      outcome satisfies never;
      return panic("Unhandled full provision outcome");
  }
};

type CitedProvisionExpansionProps = {
  citations: readonly CitedProvisionTarget[];
  full: FullProvisionRead;
  onToggleFull: MouseEventHandler<HTMLButtonElement>;
  /** Whether the reader requested the whole provision rather than the cited parts. */
  showsFull: boolean;
  wordings: readonly CitedWording[];
  placement?: ProvisionCardPlacement;
};

/**
 * Lines of wording a folded margin card shows: enough to recognise the
 * provision, few enough that a paragraph citing many provisions keeps its
 * cards beside it.
 */
const GUTTER_GLIMPSE_LINES = "max-h-[2lh]";

/**
 * How much wording a card shows. Under a paragraph the card grows with the
 * reader's single scroll. The margin is shared by every note on the page and
 * each is pushed down by the ones above it, so a margin card never grows
 * past a fixed height: folded it shows a glimpse, open it scrolls inside.
 */
const WordingFrame = ({
  children,
  expanded,
  placement,
}: {
  children: ReactNode;
  expanded: boolean;
  placement: ProvisionCardPlacement;
}): ReactNode => {
  if (placement === "inline") {
    return children;
  }
  return expanded ? (
    <ScrollArea
      axis="vertical"
      className="max-h-64"
      data-slot="provision-card-scroll"
      scrollFade
    >
      {children}
    </ScrollArea>
  ) : (
    <div
      className={cn(
        "block overflow-hidden",
        GUTTER_NOTE_TYPE,
        GUTTER_GLIMPSE_LINES,
      )}
      data-slot="provision-card-glimpse"
    >
      {children}
    </div>
  );
};

/**
 * One cited provision beside the paragraph that cites it: one header row,
 * where the provision sits when that fits on a line, then each cited part
 * in full and, on request, the rest of the provision around them. Every
 * citation of the provision in the paragraph shares the card. Rendered by
 * the paragraph owner, never by its inline citation link.
 */
export const CitedProvisionExpansion = ({
  citations,
  full,
  onToggleFull,
  showsFull,
  wordings,
  placement = "inline",
}: CitedProvisionExpansionProps) => {
  const [expanded, setExpanded] = useState(false);
  const messages = useReaderMessages();
  const first = citations.at(0) ?? panic("A provision card without citations");
  const statuteLists = statuteListSchemeFor(first.document.country);
  const passage = provisionCardPassage(wordings);
  const outcome = fullProvisionOutcome(full);
  const displaysFullText = showsFull && outcome.type === "text";
  const label = messages.formatLabelList(provisionCardLabels(citations));
  const firstWording = wordings.at(0)?.wording;
  const foldable =
    provisionCardScope(citations) === PROVISION_CARD_SCOPE.parts &&
    passage.type === "passage" &&
    passage.blocks.length > 0;
  const extent = placement === "gutter" && !expanded ? "glimpse" : "all";
  const toggleExpanded = () => setExpanded((current) => !current);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A key pressed on a control inside the card belongs to that control:
    // only the card's own focus toggles it.
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    toggleExpanded();
  };

  return (
    <ReaderInsetBox
      aria-expanded={expanded}
      className={cn(
        PROVISION_CARD_GROUP,
        "flex cursor-pointer flex-col gap-1.5",
        placement === "inline" ? "my-2" : "w-full",
      )}
      data-reader-chrome=""
      data-placement={placement}
      data-slot="provision-card"
      density="compact"
      onClick={toggleExpanded}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
    >
      <ProvisionCardHeader
        actionPresence={PEEK_ACTION_PRESENCE.revealOnCard}
        label={label}
        provision={first}
      />
      <div
        className={cn(
          "contents",
          !expanded && placement === "inline" && "hidden",
        )}
      >
        <span className={cn("contents", !expanded && "hidden")}>
          <ProvisionTrailLine
            language={firstWording?.language}
            trail={provisionTrail({ label, passage, wording: firstWording })}
          />
        </span>
        <WordingFrame expanded={expanded} placement={placement}>
          {foldable && showsFull ? (
            <FullProvisionWording
              extent={extent}
              outcome={outcome}
              passage={passage}
              placement={placement}
              statuteLists={statuteLists}
              wordings={wordings}
            />
          ) : (
            <PassageBody
              extent={extent}
              passage={passage}
              placement={placement}
              statuteLists={statuteLists}
            />
          )}
        </WordingFrame>
        {foldable && (
          <span
            className={cn("reader-chrome self-start", !expanded && "hidden")}
          >
            <Button
              aria-expanded={displaysFullText}
              disabled={showsFull && outcome.type === "pending"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFull(event);
              }}
              size="xs"
              variant="link"
            >
              {displaysFullText
                ? messages["statutes.showCitedPartOnly"]
                : messages["statutes.showFullProvision"]}
            </Button>
          </span>
        )}
      </div>
    </ReaderInsetBox>
  );
};

/**
 * The peek's body, read only while the peek is open: where the provision
 * sits and its wording. The shell bounds its height and scrolls it, so a
 * long provision never runs past the screen edge.
 */
export const CitedProvisionPeek = ({
  provision,
  wordings,
}: {
  provision: CitedProvisionTarget;
  wordings: readonly CitedWording[];
}) => {
  const passage = provisionCardPassage(wordings);
  const wording = wordings.at(0)?.wording;
  const label = provision.payload.provisionLabel;
  return (
    <>
      <ProvisionTrailLine
        language={wording?.language}
        trail={provisionTrail({ label, passage, wording })}
      />
      <PassageBody
        passage={passage}
        statuteLists={statuteListSchemeFor(provision.document.country)}
      />
    </>
  );
};

type CitedProvisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  provision: CitedProvisionTarget;
  /** The peek's body, which reads the wording once it is mounted. */
  body: ReactNode;
};

/** Hover or a plain click peeks at wording without interrupting the sentence. */
export const CitedProvisionLink = ({
  children,
  className,
  provision,
  body,
}: CitedProvisionLinkProps) => {
  const { provisionPageLink } = useReaderAdapters();
  return (
    <ReferencePeek
      body={body}
      header={{
        primary: provision.payload.provisionLabel,
        meta: useProvisionHeaderMeta(provision.payload),
      }}
      target={useProvisionPeekTarget(provision)}
      className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
      trigger={{ type: "link", element: provisionPageLink(provision) }}
    >
      {children}
    </ReferencePeek>
  );
};

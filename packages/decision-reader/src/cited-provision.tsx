import type { MouseEventHandler, ReactElement, ReactNode } from "react";

import { panic } from "better-result";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { PanelRightIcon } from "@stll/ui/icons";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import {
  informativeProvisionTrail,
  PROVISION_CARD_SCOPE,
  provisionCardLabels,
  provisionCardPassage,
  provisionCardScope,
} from "./provision-card.logic";
import type {
  CitedWording,
  ProvisionCardPassage,
} from "./provision-card.logic";
import { useReaderAdapters, useReaderMessages } from "./reader-adapters";
import { ReaderInsetBox } from "./reader-inset-box";
import type {
  CitedProvisionTarget,
  ProvisionPreviewData,
  ProvisionViewPayload,
} from "./reader-types";

const HeaderSeparator = () => (
  <span aria-hidden="true" className="text-muted-foreground shrink-0 text-xs">
    ·
  </span>
);

type ProvisionCardHeaderProps = {
  /** What the card is about, e.g. `§ 226 odst. 1`; never shortened. */
  label: string;
  provision: ProvisionViewPayload;
};

/**
 * The one header every cited-provision card draws, inline under a paragraph
 * and in the citation's hover card: one row naming the provision, the act
 * by number and title, the date the quoted wording took effect, and a
 * button that opens the provision.
 *
 * The row never wraps, and the open button sits outside the part that gives
 * way, so it is always there to press. When the rest runs out of room it
 * gives way in a fixed order: the act's title first (it takes only the room
 * left once the label and the date fit), then the provision label (its full
 * text stays in the tooltip), and the date last, cut off at the edge.
 */
export const ProvisionCardHeader = ({
  label,
  provision,
}: ProvisionCardHeaderProps) => {
  const messages = useReaderMessages();
  const { openProvision } = useReaderAdapters();
  const actText = messages.provisionActText(provision);
  const date = messages.formatValidityDate(provision.versionValidFrom);

  return (
    <span
      className="reader-chrome flex min-w-0 items-center gap-1.5"
      data-slot="provision-card-header"
    >
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap"
        data-slot="provision-card-summary"
      >
        <BidiText
          as="span"
          className="min-w-0 truncate text-sm font-medium"
          data-slot="provision-card-label"
          title={label}
        >
          {label}
        </BidiText>
        {actText !== "" && (
          <>
            <HeaderSeparator />
            <BidiText
              as="span"
              className="text-muted-foreground max-w-max min-w-0 flex-1 basis-0 truncate text-xs"
              data-slot="provision-card-act"
              title={actText}
            >
              {actText}
            </BidiText>
          </>
        )}
        <HeaderSeparator />
        <span
          className="text-muted-foreground shrink-0 text-xs"
          data-slot="provision-card-date"
        >
          {date === null
            ? messages["statutes.wordingVersionUnknown"]
            : messages.provisionEffectiveFrom(date)}
        </span>
      </span>
      <Button
        aria-label={messages["statutes.openProvision"]}
        className="shrink-0"
        onClick={() => openProvision(provision)}
        size="icon-xs"
        tooltip={messages["statutes.openProvision"]}
        variant="ghost"
      >
        <PanelRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </span>
  );
};

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

const ProvisionTextUnavailable = () => {
  const messages = useReaderMessages();
  return (
    <span
      className="reader-chrome text-muted-foreground text-xs"
      data-slot="provision-card-unavailable"
    >
      {messages["statutes.provisionTextUnavailable"]}
    </span>
  );
};

type ProvisionWordingProps = {
  blocks: ProvisionPreviewData["blocks"];
  /** Blocks a citation of a part names, marked beside the rest. */
  cited: ReadonlySet<string>;
  language: string | null;
};

/**
 * Wording in the reader's own flow. It is never a scroller of its own: the
 * reader keeps one scroll, and a long provision makes the card taller.
 */
const ProvisionWording = ({
  blocks,
  cited,
  language,
}: ProvisionWordingProps) => (
  <span
    className="reader-body text-foreground flex flex-col gap-2 text-sm leading-relaxed text-pretty"
    data-slot="provision-card-wording"
    lang={language ?? undefined}
  >
    {blocks.map((block) => (
      <span
        className={cn(
          cited.has(block.id) && "border-primary/50 border-s-[3px] ps-2.5",
        )}
        data-cited={cited.has(block.id) ? "" : undefined}
        key={block.id}
      >
        {block.text}
      </span>
    ))}
  </span>
);

const PassageBody = ({ passage }: { passage: ProvisionCardPassage }) => {
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
            language={passage.language}
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

/** What reading the whole provision answered, once the reader asked for it. */
export type FullProvisionRead = {
  isPending: boolean;
  /** Null while unread, and when the read failed or found nothing. */
  whole: ProvisionPreviewData | null;
};

/**
 * The whole provision around the cited parts. Until it answers, and if it
 * cannot, the cited parts stay as they were.
 */
const FullProvisionWording = ({
  full,
  passage,
  wordings,
}: {
  full: FullProvisionRead;
  passage: ProvisionCardPassage;
  wordings: readonly CitedWording[];
}) => {
  if (full.whole === null || full.whole.blocks.length === 0) {
    return (
      <>
        <PassageBody passage={passage} />
        {full.isPending && <ProvisionWordingSkeleton />}
      </>
    );
  }
  return <PassageBody passage={provisionCardPassage(wordings, full.whole)} />;
};

type CitedProvisionExpansionProps = {
  citations: readonly CitedProvisionTarget[];
  full: FullProvisionRead;
  onToggleFull: MouseEventHandler<HTMLButtonElement>;
  /** Whether the card shows the whole provision rather than the cited parts. */
  showsFull: boolean;
  wordings: readonly CitedWording[];
};

/**
 * One cited provision under the paragraph that cites it: one header row,
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
}: CitedProvisionExpansionProps) => {
  const messages = useReaderMessages();
  const first = citations.at(0) ?? panic("A provision card without citations");
  const passage = provisionCardPassage(wordings);
  const label = messages.formatLabelList(provisionCardLabels(citations));
  const firstWording = wordings.at(0)?.wording;
  const foldable =
    provisionCardScope(citations) === PROVISION_CARD_SCOPE.parts &&
    passage.type === "passage" &&
    passage.blocks.length > 0;

  return (
    <ReaderInsetBox
      className="my-2 flex flex-col gap-1.5"
      data-reader-chrome=""
      data-slot="provision-card"
      density="compact"
    >
      <ProvisionCardHeader label={label} provision={first.payload} />
      <ProvisionTrailLine
        language={firstWording?.language}
        trail={provisionTrail({ label, passage, wording: firstWording })}
      />
      {foldable && showsFull ? (
        <FullProvisionWording
          full={full}
          passage={passage}
          wordings={wordings}
        />
      ) : (
        <PassageBody passage={passage} />
      )}
      {foldable && (
        <span className="reader-chrome self-start">
          <Button
            aria-expanded={showsFull}
            onClick={onToggleFull}
            size="xs"
            variant="link"
          >
            {showsFull
              ? messages["statutes.showCitedPartOnly"]
              : messages["statutes.showFullProvision"]}
          </Button>
        </span>
      )}
    </ReaderInsetBox>
  );
};

/** The hover card's content, read only while the card is open. */
const CitedProvisionPeek = ({
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
      <ProvisionCardHeader label={label} provision={provision.payload} />
      <ProvisionTrailLine
        language={wording?.language}
        trail={provisionTrail({ label, passage, wording })}
      />
      <PassageBody passage={passage} />
    </>
  );
};

type CitedProvisionLinkProps = {
  children: ReactNode;
  provision: CitedProvisionTarget;
  previewOpen: boolean;
  onPreviewOpenChange: (open: boolean) => void;
  link: ReactElement;
  /** The wording of `provision` alone, as the host read it. */
  wordings: readonly CitedWording[];
};

/** Hover or a plain click peeks at wording without interrupting the sentence. */
export const CitedProvisionLink = ({
  children,
  provision,
  previewOpen,
  onPreviewOpenChange,
  link,
  wordings,
}: CitedProvisionLinkProps) => (
  <PreviewCard onOpenChange={onPreviewOpenChange} open={previewOpen}>
    <PreviewCardTrigger render={link}>{children}</PreviewCardTrigger>
    <PreviewCardPopup className="reader-chrome w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-1.5 p-3">
      <CitedProvisionPeek provision={provision} wordings={wordings} />
    </PreviewCardPopup>
  </PreviewCard>
);

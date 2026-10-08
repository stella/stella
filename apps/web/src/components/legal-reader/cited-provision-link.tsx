import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { LEGAL_CITATION_LINK_CLASS_NAME } from "@/components/legal-reader/citation-link";
import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
  informativeProvisionTrail,
  PROVISION_CARD_SCOPE,
  provisionCardLabels,
  provisionCardPassage,
  provisionCardScope,
} from "@/components/legal-reader/cited-provision-link.logic";
import type {
  CitedProvisionTarget,
  ProvisionCardPassage,
} from "@/components/legal-reader/cited-provision-link.logic";
import {
  ProvisionCardHeader,
  ProvisionTrailLine,
} from "@/components/legal-reader/provision-card-header";
import { ReaderInsetBox } from "@/components/legal-reader/reader-inset-box";
import {
  keepReadingPosition,
  readerScrollOwner,
} from "@/components/legal-reader/reader-position";
import {
  provisionInVersionOptions,
  provisionPreviewOptions,
} from "@/features/statutes/queries/provision-preview";
import type { ProvisionPreviewData } from "@/features/statutes/queries/provision-preview";
import { queryView } from "@/lib/query-view.logic";
import { createStatuteLinkTarget } from "@/lib/statute-route";
import {
  useQueryView,
  useQueryViewError,
  useQueryViewErrors,
} from "@/lib/use-query-view";

type CitedProvisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  provision: CitedProvisionTarget;
};

const citationPreviewOptions = ({ document, payload }: CitedProvisionTarget) =>
  provisionPreviewOptions({
    anchor: payload.anchorId,
    citedAnchor: payload.highlightAnchorId,
    documentId: document.id,
  });

type CitedWordingsArgs = {
  citations: readonly CitedProvisionTarget[];
  /** False while nothing is showing the wording, so nothing is read for it. */
  enabled: boolean;
};

/**
 * The wording each citation points at: the one the decision's list carried,
 * or a read of its own. The hover card and the paragraph card ask under the
 * same key, so unfolding a citation the reader has already hovered costs no
 * second read. A read that failed or found nothing answers null.
 */
const useCitedWordings = ({ citations, enabled }: CitedWordingsArgs) => {
  const reads = useQueries({
    queries: citations.map((target) => ({
      ...citationPreviewOptions(target),
      enabled: enabled && target.preview === null,
    })),
  });
  const views = reads.map((read) => queryView(read));
  useQueryViewErrors(views);
  return citations.map((target, index) => {
    if (target.preview !== null) {
      return { target, wording: target.preview };
    }
    const view = views.at(index) ?? panic("A citation without its read");
    switch (view.type) {
      case "items":
        return { target, wording: view.items };
      case "pending":
        return { target, wording: undefined };
      case "empty":
      case "error":
        return { target, wording: null };
      default:
        view satisfies never;
        return panic("Unhandled provision wording read");
    }
  });
};

const ProvisionWordingSkeleton = () => (
  <span className="flex flex-col gap-1.5" data-slot="provision-card-pending">
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-5/6" />
  </span>
);

const ProvisionTextUnavailable = () => {
  const t = useTranslations();
  return (
    <span
      className="reader-chrome text-muted-foreground text-xs"
      data-slot="provision-card-unavailable"
    >
      {t("statutes.provisionTextUnavailable")}
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
  switch (passage.type) {
    case "pending":
      return <ProvisionWordingSkeleton />;
    case "passage":
      return passage.blocks.length === 0 ? (
        <ProvisionTextUnavailable />
      ) : (
        <ProvisionWording
          blocks={passage.blocks}
          cited={passage.cited}
          language={passage.language}
        />
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

type FullProvisionProps = {
  citations: readonly CitedProvisionTarget[];
  /** The cited parts, shown until the whole provision has been read. */
  passage: ProvisionCardPassage;
};

const NOTHING_CITED: ReadonlySet<string> = new Set();

/**
 * The whole provision around the cited parts, read when the reader asks
 * for it. Until it answers, and if it cannot, the cited parts stay as they
 * were.
 */
const FullProvisionWording = ({ citations, passage }: FullProvisionProps) => {
  const first = citations.at(0) ?? panic("A provision card without citations");
  const read = useQuery(
    provisionInVersionOptions({
      anchor: first.payload.anchorId,
      documentId: first.document.id,
    }),
  );
  const view = useQueryView(read);
  useQueryViewError(view);
  const whole = view.type === "items" ? view.items : null;
  if (whole === null || whole.blocks.length === 0) {
    return (
      <>
        <PassageBody passage={passage} />
        {view.type === "pending" && <ProvisionWordingSkeleton />}
      </>
    );
  }
  return (
    <ProvisionWording
      blocks={whole.blocks}
      cited={passage.type === "passage" ? passage.cited : NOTHING_CITED}
      language={whole.language}
    />
  );
};

const FULL_PROVISION = { cited: "cited", full: "full" } as const;
type FullProvisionState = keyof typeof FULL_PROVISION;

/**
 * One cited provision under the paragraph that cites it: one header row,
 * where the provision sits when that fits on a line, then each cited part
 * in full and, on request, the rest of the provision around them. Every
 * citation of the provision in the paragraph shares the card.
 */
export const CitedProvisionExpansion = ({
  citations,
}: {
  citations: readonly CitedProvisionTarget[];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const [shown, setShown] = useState<FullProvisionState>(FULL_PROVISION.cited);
  const first = citations.at(0) ?? panic("A provision card without citations");
  const wordings = useCitedWordings({ citations, enabled: true });
  const passage = provisionCardPassage(wordings);
  const label = format.list(provisionCardLabels(citations), {
    style: "short",
    type: "unit",
  });
  const firstWording = wordings.at(0)?.wording;
  const foldable =
    provisionCardScope(citations) === PROVISION_CARD_SCOPE.parts &&
    passage.type === "passage" &&
    passage.blocks.length > 0;

  const onToggle = (event: MouseEvent<HTMLButtonElement>) => {
    const toggle = event.currentTarget;
    keepReadingPosition(
      { anchor: toggle, scroller: readerScrollOwner(toggle) },
      () => {
        setShown((current) =>
          current === FULL_PROVISION.full
            ? FULL_PROVISION.cited
            : FULL_PROVISION.full,
        );
      },
    );
  };

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
      {foldable && shown === FULL_PROVISION.full ? (
        <FullProvisionWording citations={citations} passage={passage} />
      ) : (
        <PassageBody passage={passage} />
      )}
      {foldable && (
        <span className="reader-chrome self-start">
          <Button
            aria-expanded={shown === FULL_PROVISION.full}
            onClick={onToggle}
            size="xs"
            variant="link"
          >
            {shown === FULL_PROVISION.full
              ? t("statutes.showCitedPartOnly")
              : t("statutes.showFullProvision")}
          </Button>
        </span>
      )}
    </ReaderInsetBox>
  );
};

/** The hover card's content, read only while the card is open. */
const CitedProvisionPeek = ({
  enabled,
  provision,
}: {
  enabled: boolean;
  provision: CitedProvisionTarget;
}) => {
  const wordings = useCitedWordings({ citations: [provision], enabled });
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

/** Hover or a plain click peeks at wording without interrupting the sentence. */
export const CitedProvisionLink = ({
  children,
  className,
  provision,
}: CitedProvisionLinkProps) => {
  const [previewOpen, setPreviewOpen] = useState(false);

  const onProvisionClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const click = citedProvisionClick(event);
    switch (click) {
      case CITED_PROVISION_CLICK.navigate:
        break;
      case CITED_PROVISION_CLICK.peek:
        event.preventDefault();
        setPreviewOpen(true);
        break;
      default:
        click satisfies never;
        panic(`Unhandled cited-provision click: ${String(click)}`);
    }
  };

  return (
    <PreviewCard onOpenChange={setPreviewOpen} open={previewOpen}>
      <PreviewCardTrigger
        render={
          <Link
            aria-expanded={previewOpen}
            className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
            hash={
              provision.payload.highlightAnchorId ?? provision.payload.anchorId
            }
            onClick={onProvisionClick}
            {...createStatuteLinkTarget({
              country: provision.document.country,
              documentId: provision.document.id,
              eli: provision.document.eli,
              slug: provision.document.slug,
              versionValidFrom: provision.document.versionValidFrom,
            })}
          />
        }
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardPopup className="reader-chrome w-[min(32rem,calc(100vw-2rem))] max-w-none flex-col gap-1.5 p-3">
        <CitedProvisionPeek enabled={previewOpen} provision={provision} />
      </PreviewCardPopup>
    </PreviewCard>
  );
};

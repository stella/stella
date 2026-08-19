import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/components/sheet";
import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";

import {
  diffProvisionText,
  resolveSelectedVersion,
  selectChangedVersions,
} from "@/features/statutes/provision-diff";
import type { ProvisionDiffSegment } from "@/features/statutes/provision-diff";
import { provisionHistoryOptions } from "@/features/statutes/queries/provision-history";
import {
  EM_DASH,
  formatValidityDate,
} from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import {
  TRACKED_DELETION_STYLE,
  TRACKED_INSERTION_STYLE,
} from "@/lib/track-changes-style";

type ProvisionHistoryProps = {
  /** The provision heading's anchor, the id the history is filed under. */
  anchorId: string;
  /** The consolidation on screen; the read resolves its Work from this. */
  documentId: string;
  /** The heading's own text, so the panel names the provision it is about. */
  provision: string;
};

/**
 * Opens one provision's drafting history: the consolidations in which it was
 * rewritten, and the word-level difference each rewrite made.
 */
export const ProvisionHistory = ({
  anchorId,
  documentId,
  provision,
}: ProvisionHistoryProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        render={
          <Button
            aria-label={t("statutes.provisionHistoryFor", { provision })}
            className="text-muted-foreground hover:text-foreground -mt-1 mb-2 h-auto px-1 py-0.5 text-xs font-normal"
            size="sm"
            variant="ghost"
          />
        }
      >
        <HistoryIcon aria-hidden="true" className="size-3" />
        {t("common.history")}
      </SheetTrigger>
      <SheetPopup side="inline-end" variant="inset">
        <SheetHeader>
          <SheetTitle>
            {t("statutes.provisionHistoryFor", { provision })}
          </SheetTitle>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          {open && (
            <ProvisionHistoryBody anchorId={anchorId} documentId={documentId} />
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
};

type ProvisionHistoryBodyProps = {
  anchorId: string;
  documentId: string;
};

/**
 * Rendered only while the panel is open, so a page of provisions costs no
 * requests until a reader asks about one of them.
 */
const ProvisionHistoryBody = ({
  anchorId,
  documentId,
}: ProvisionHistoryBodyProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, fetchNextPage, hasNextPage, isError, isFetchingNextPage } =
    useInfiniteQuery(provisionHistoryOptions({ anchor: anchorId, documentId }));

  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("statutes.provisionHistoryUnavailable")}
      </p>
    );
  }

  if (data === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const consolidations = data.pages.flatMap((page) => page.items);
  const versions = selectChangedVersions(consolidations);
  const selected = resolveSelectedVersion({
    changed: versions,
    consolidations,
    selectedId,
  });

  if (selected === undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("statutes.provisionHistoryEmpty")}
      </p>
    );
  }

  const previous = versions.at(versions.indexOf(selected) + 1);
  const label = (validFrom: string | null): string =>
    formatValidityDate(validFrom, format) ?? EM_DASH;

  return (
    <>
      <ul className="flex flex-col gap-1" aria-label={t("common.version")}>
        {versions.map((version) => (
          <li key={version.documentId}>
            <Button
              aria-current={
                version.documentId === selected.documentId ? "true" : undefined
              }
              className={cn(
                "h-auto w-full justify-start px-2 py-1.5 text-xs font-normal",
                version.documentId === selected.documentId && "bg-accent",
              )}
              onClick={() => {
                setSelectedId(version.documentId);
              }}
              variant="ghost"
            >
              {t("statutes.inForceSince", {
                date: label(version.versionValidFrom),
              })}
            </Button>
          </li>
        ))}
      </ul>

      {hasNextPage && (
        <Button
          className="w-full"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "statutes.provision-history-page");
          }}
          size="sm"
          variant="outline"
        >
          {t("common.loadMore")}
        </Button>
      )}

      {/* With no older wording loaded there is nothing to diff against, so
          the panel shows the wording itself and says why. */}
      <ProvisionDiff after={selected.text} before={previous?.text ?? null} />
      {previous === undefined && (
        <p className="text-muted-foreground text-xs">
          {hasNextPage
            ? t("statutes.provisionHistoryLoadOlder")
            : t("statutes.provisionHistoryEarliest")}
        </p>
      )}
    </>
  );
};

type ProvisionDiffProps = {
  /** The older wording, or null when this is the earliest one on record. */
  before: string | null;
  after: string;
};

const ProvisionDiff = ({ after, before }: ProvisionDiffProps) => {
  if (before === null) {
    return <p className="text-sm leading-6 whitespace-pre-wrap">{after}</p>;
  }

  return (
    <p className="text-sm leading-6 whitespace-pre-wrap">
      {withOffsets(diffProvisionText(before, after)).map(
        ({ offset, segment }) => (
          <ProvisionDiffRun key={offset} segment={segment} />
        ),
      )}
    </p>
  );
};

type OffsetSegment = {
  offset: number;
  segment: ProvisionDiffSegment;
};

/**
 * Segments carry no identity of their own, but their position in the
 * concatenated text is unique and stable for a given pair of wordings.
 */
const withOffsets = (
  segments: readonly ProvisionDiffSegment[],
): OffsetSegment[] => {
  const positioned: OffsetSegment[] = [];
  let offset = 0;

  for (const segment of segments) {
    positioned.push({ offset, segment });
    offset += segment.text.length;
  }

  return positioned;
};

const ProvisionDiffRun = ({ segment }: { segment: ProvisionDiffSegment }) => {
  const t = useTranslations();

  if (segment.kind === "inserted") {
    return (
      <ins style={TRACKED_INSERTION_STYLE}>
        <span className="sr-only">{t("statutes.diffInserted")}</span>
        {segment.text}
      </ins>
    );
  }

  if (segment.kind === "removed") {
    return (
      <del style={TRACKED_DELETION_STYLE}>
        <span className="sr-only">{t("statutes.diffRemoved")}</span>
        {segment.text}
      </del>
    );
  }

  return <span>{segment.text}</span>;
};

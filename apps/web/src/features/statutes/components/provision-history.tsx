import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  ReviewDiffDeletion,
  ReviewDiffInsertion,
} from "@stll/ui/review-diff-text";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

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

type ProvisionHistoryProps = {
  /** The provision heading's anchor, the id the history is filed under. */
  anchorId: string;
  /** The consolidation on screen; the read resolves its Work from this. */
  documentId: string;
};

/**
 * One provision's drafting history: the consolidations in which it was
 * rewritten, and the word-level difference each rewrite made. Mounted only
 * inside the provision's inspector tab, so a page of provisions costs no
 * requests until a reader asks about one of them.
 */
export const ProvisionHistory = ({
  anchorId,
  documentId,
}: ProvisionHistoryProps) => {
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
    <div className="flex flex-col gap-3">
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
    </div>
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
      <ReviewDiffInsertion>
        <span className="sr-only">{t("statutes.diffInserted")}</span>
        {segment.text}
      </ReviewDiffInsertion>
    );
  }

  if (segment.kind === "removed") {
    return (
      <ReviewDiffDeletion>
        <span className="sr-only">{t("statutes.diffRemoved")}</span>
        {segment.text}
      </ReviewDiffDeletion>
    );
  }

  return <span>{segment.text}</span>;
};

import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Columns2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { diffWordSegments } from "@stll/folio-core/ai-edits";
import {
  parseDocumentAst,
  resolveDocumentHeadingAnchor,
} from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { HighlightedText } from "@/components/legal-reader/document-ast-text";
import {
  resolveSelectedVersion,
  selectChangedVersions,
} from "@/features/statutes/provision-diff";
import { provisionHistoryOptions } from "@/features/statutes/queries/provision-history";
import { statuteOptions } from "@/features/statutes/queries/statutes";
import { diffMarkRanges } from "@/features/statutes/statute-diff-marks";
import {
  EM_DASH,
  formatValidityDate,
} from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { createStatuteLinkTarget } from "@/lib/statute-route";

// The history marks its diff only; it carries no find.
const NO_ACTIVE_MATCH = -1;

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
  const {
    data: statute,
    isError: isStatuteError,
    isPending: isStatutePending,
  } = useQuery(statuteOptions(documentId));
  const ast =
    statute === undefined ? null : parseDocumentAst(statute.documentAst);
  const resolvedAnchor =
    ast === null
      ? null
      : (resolveDocumentHeadingAnchor(ast.blocks, anchorId)?.anchorId ?? null);
  const { data, fetchNextPage, hasNextPage, isError, isFetchingNextPage } =
    useInfiniteQuery({
      ...provisionHistoryOptions({
        anchor: resolvedAnchor ?? anchorId,
        documentId,
      }),
      enabled: resolvedAnchor !== null,
    });

  if (
    isError ||
    isStatuteError ||
    (!isStatutePending && resolvedAnchor === null)
  ) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("statutes.provisionHistoryUnavailable")}
      </p>
    );
  }

  if (data === undefined || isStatutePending) {
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
  // The comparison sets a past wording beside the consolidation this tab
  // shows. When the selected wording is that consolidation's own, the past
  // one is the wording it replaced.
  const onScreenText = consolidations.find(
    (version) => version.documentId === documentId,
  )?.text;
  const compareWith =
    selected.documentId === documentId || selected.text === onScreenText
      ? previous
      : selected;
  const compareFrom = compareWith?.versionValidFrom ?? null;
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
      {compareFrom !== null && (
        <Button
          className="self-start"
          render={
            <Link
              {...createStatuteLinkTarget({
                country: statute.country,
                documentId,
                eli: statute.eli,
                slug: statute.slug,
                versionValidFrom: statute.versionValidFrom,
              })}
              search={{
                compare: compareFrom,
                provision: resolvedAnchor ?? anchorId,
              }}
            />
          }
          size="sm"
          variant="outline"
        >
          <Columns2Icon className="size-3.5" />
          {t("statutes.compareSideBySide")}
        </Button>
      )}
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

  const segments = diffWordSegments(before, after);

  // Deletions and insertions inline in one wording, marked the way the
  // comparison and the reader mark them.
  return (
    <p className="text-sm leading-6 whitespace-pre-wrap">
      <HighlightedText
        activeMatchIndex={NO_ACTIVE_MATCH}
        pieceId="provision-diff"
        ranges={diffMarkRanges(segments)}
        text={segments.map((segment) => segment.text).join("")}
      />
    </p>
  );
};

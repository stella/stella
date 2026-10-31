import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import {
  parseDocumentAst,
  resolveDocumentHeadingAnchor,
} from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/button";
import { Columns2Icon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { selectChangedVersions } from "@/features/statutes/provision-diff";
import { provisionHistoryOptions } from "@/features/statutes/queries/provision-history";
import { statuteOptions } from "@/features/statutes/queries/statutes";
import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import {
  EM_DASH,
  formatValidityDate,
  formatValidityRange,
} from "@/lib/statutes/statute-format";
import { createStatuteLinkTarget } from "@/lib/statutes/statute-route";

const HISTORY_ROW_CLASS =
  "flex min-h-8 items-center gap-2 rounded-md px-2 text-xs tabular-nums pointer-coarse:min-h-11";

type ProvisionHistoryProps = {
  /** The provision heading's anchor, the id the history is filed under. */
  anchorId: string;
  /** The consolidation on screen; the read resolves its Work from this. */
  documentId: string;
};

/**
 * The wordings this provision has had, one row each, newest first. A row
 * opens the reader's own comparison of that wording against the one on
 * screen, so the difference is read where every other difference is.
 * Mounted only inside the provision's inspector tab, so a page of provisions
 * costs no requests until a reader asks about one of them.
 */
export const ProvisionHistory = ({
  anchorId,
  documentId,
}: ProvisionHistoryProps) => {
  const t = useTranslations();
  const format = useFormatter();
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
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionHistoryUnavailable")}
      </p>
    );
  }

  if (data === undefined || isStatutePending) {
    return (
      <div aria-busy="true" className="flex flex-col gap-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  const consolidations = data.pages.flatMap((page) => page.items);
  const versions = selectChangedVersions(consolidations);

  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionHistoryEmpty")}
      </p>
    );
  }

  // The consolidation on screen may reissue a wording an older one brought
  // in; the row of that wording is the one on screen.
  const onScreenText = consolidations.find(
    (version) => version.documentId === documentId,
  )?.text;
  const comparisonTarget = createStatuteLinkTarget({
    country: statute.country,
    documentId,
    eli: statute.eli,
    slug: statute.slug,
    versionValidFrom: statute.versionValidFrom,
  });
  const provision = resolvedAnchor ?? anchorId;
  // A wording that cannot apply was never in force from its start date: it
  // is named for what it is, beside the dates its publisher stated.
  const versionLabel = (version: (typeof versions)[number]): string => {
    const ineligibleLabel = ineligibleExpressionLabelKey(version);
    return ineligibleLabel === null
      ? t("statutes.inForceSince", {
          date: formatValidityDate(version.versionValidFrom, format) ?? EM_DASH,
        })
      : t("statutes.ineligibleVersion", {
          label: t(ineligibleLabel),
          range: formatValidityRange({
            format,
            openEnded: t("statutes.openEnded"),
            validFrom: version.versionValidFrom,
            validTo: version.versionValidTo,
          }),
        });
  };

  return (
    <div className="flex flex-col gap-1">
      <ol aria-label={t("common.history")} className="m-0 list-none p-0">
        {versions.map((version) => {
          const label = versionLabel(version);
          const onScreen =
            version.documentId === documentId || version.text === onScreenText;
          // As in the version menu, a wording that cannot apply offers no
          // window to compare by.
          const compareFrom =
            onScreen || ineligibleExpressionLabelKey(version) !== null
              ? null
              : version.versionValidFrom;
          return (
            <li key={version.documentId}>
              {compareFrom === null ? (
                <span
                  aria-current={onScreen ? "true" : undefined}
                  className={HISTORY_ROW_CLASS}
                >
                  <span
                    className={cn(
                      onScreen ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </span>
              ) : (
                <Link
                  aria-label={t("statutes.compareWithVersion", {
                    version: label,
                  })}
                  className={cn(
                    HISTORY_ROW_CLASS,
                    "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring justify-between focus-visible:ring-2 focus-visible:outline-none",
                  )}
                  search={{ compare: compareFrom, provision }}
                  title={t("statutes.compareSideBySide")}
                  {...comparisonTarget}
                >
                  <span className="min-w-0 truncate">{label}</span>
                  <Columns2Icon aria-hidden="true" className="size-3.5" />
                </Link>
              )}
            </li>
          );
        })}
      </ol>
      {hasNextPage && (
        <Button
          className="self-start"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "statutes.provision-history-page");
          }}
          size="sm"
          variant="ghost"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { statuteAnchorSchemeFor } from "@stll/api-contract/statute-anchor-schemes";
import {
  parseDocumentAst,
  resolveDocumentHeadingAnchor,
} from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/button";
import { Columns2Icon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import {
  groupWordingRuns,
  isRunStartKnown,
} from "@/features/statutes/provision-version-runs.logic";
import type { ProvisionHistoryItem } from "@/features/statutes/queries/provision-history";
import { provisionHistoryOptions } from "@/features/statutes/queries/provision-history";
import { statuteOptions } from "@/features/statutes/queries/statutes";
import { ineligibleExpressionLabelKey } from "@/features/statutes/statute-expression";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import {
  EM_DASH,
  formatValidityDate,
  formatValidityRange,
} from "@/lib/statutes/statute-format";
import { createStatuteLinkTarget } from "@/lib/statutes/statute-route";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

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
  const { anchor: historyAnchor, statute } = useProvisionHistoryAnchor({
    anchorId,
    documentId,
  });
  const { data, fetchNextPage, hasNextPage, isError, isFetchingNextPage } =
    useInfiniteQuery({
      ...provisionHistoryOptions({
        anchor:
          historyAnchor.type === "resolved" ? historyAnchor.anchor : anchorId,
        documentId,
      }),
      enabled: historyAnchor.type === "resolved",
    });

  if (isError || historyAnchor.type === "unavailable") {
    return (
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionHistoryUnavailable")}
      </p>
    );
  }

  if (data === undefined || statute === undefined) {
    return (
      <div aria-busy="true" className="flex flex-col gap-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  // One row per wording, dated by the consolidation that brought it in. A
  // consolidation that reissues the wording unchanged is folded into it, as
  // the server compared it on the full text.
  const groups = groupWordingRuns(data.pages.flatMap((page) => page.items));

  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("statutes.provisionHistoryEmpty")}
      </p>
    );
  }

  const comparisonTarget = createStatuteLinkTarget({
    country: statute.country,
    documentId,
    eli: statute.eli,
    slug: statute.slug,
    versionValidFrom: statute.versionValidFrom,
  });
  const provision =
    historyAnchor.type === "resolved" ? historyAnchor.anchor : anchorId;
  // A wording that cannot apply was never in force from its start date: it
  // is named for what it is, beside the dates its publisher stated.
  // A wording whose start lies on a page not read yet, or behind a version
  // whose text could not be read, is dated by its oldest version listed, and
  // says it may reach further back.
  const versionLabel = (
    version: ProvisionHistoryItem,
    startKnown = true,
  ): string => {
    const ineligibleLabel = ineligibleExpressionLabelKey(version);
    const date =
      formatValidityDate(version.versionValidFrom, format) ?? EM_DASH;
    if (ineligibleLabel === null) {
      return startKnown
        ? t("statutes.inForceSince", { date })
        : t("statutes.inForceSinceAtLeast", { date });
    }
    return t("statutes.ineligibleVersion", {
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
        {groups.map((group) => {
          if (group.type === "unavailable") {
            return (
              <li key={group.item.documentId}>
                <span className={HISTORY_ROW_CLASS}>
                  <span className="text-muted-foreground">
                    {versionLabel(group.item)}
                    {" · "}
                    {t("statutes.provisionTextUnavailable")}
                  </span>
                </span>
              </li>
            );
          }
          // The row of a wording is the consolidation that brought it in.
          const version = group.members.at(-1);
          if (version === undefined) {
            return null;
          }
          const label = versionLabel(version, isRunStartKnown(group.start));
          const onScreen = group.members.some(
            (member) => member.documentId === documentId,
          );
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
                  <TruncatedText>{label}</TruncatedText>
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

/** Whether the provision's history can be read yet, and under which anchor. */
export type ProvisionHistoryAnchor =
  | { type: "pending" }
  | { type: "resolved"; anchor: string }
  | { type: "unavailable" };

/**
 * The heading anchor a provision's history is filed under, resolved in the
 * consolidation on screen: a tab may be opened on a subdivision or on an
 * alias of the heading. Reads the act the wording pane already loads.
 */
export const useProvisionHistoryAnchor = ({
  anchorId,
  documentId,
}: ProvisionHistoryProps) => {
  // Published legislation: no workspace write changes what it reads.
  const statuteView = queryView(
    useQuery(
      resourceQueryOptions(statuteOptions(documentId), { type: "independent" }),
    ),
  );
  const statute = statuteView.type === "items" ? statuteView.items : undefined;
  const ast =
    statute === undefined ? null : parseDocumentAst(statute.documentAst);
  const resolved =
    statute === undefined || ast === null
      ? null
      : (resolveDocumentHeadingAnchor(
          {
            blocks: ast.blocks,
            scheme: statuteAnchorSchemeFor(statute.country),
          },
          anchorId,
        )?.anchorId ?? null);
  let anchor: ProvisionHistoryAnchor = { type: "pending" };
  if (resolved !== null) {
    anchor = { type: "resolved", anchor: resolved };
  } else if (statuteView.type !== "pending") {
    anchor = { type: "unavailable" };
  }
  return { anchor, statute };
};

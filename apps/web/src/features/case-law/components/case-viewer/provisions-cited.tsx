import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import {
  groupProvisionsByWork,
  type ProvisionGroup,
  type WorkGroup,
} from "@/features/case-law/components/case-viewer/provisions-cited.logic";
import type { RenderProvisionPart } from "@/features/case-law/provision-label";
import { formatProvisionReference } from "@/features/case-law/provision-label";
import {
  citedWorkAtDateKey,
  decisionProvisionsInfiniteOptions,
  statuteByCitedWork,
  statutesResolveOptions,
  statuteVersionsOptions,
} from "@/features/case-law/queries/provisions";
import type {
  CitedWorkAtDate,
  ResolvedCitedStatute,
} from "@/features/case-law/queries/provisions";
import {
  pickVersionAt,
  referencesOutsideVersion,
  versionCoversDate,
} from "@/features/case-law/statute-version";
import { useProvisionPartRenderer } from "@/features/case-law/use-provision-part-renderer";
import { useHydrated } from "@/hooks/use-hydrated";
import { optionalArray } from "@/lib/arrays";
import { decisionDateToIso } from "@/lib/decision-date";
import { detached } from "@/lib/detached";
import type { SafeId } from "@/lib/safe-id";
import type { StatuteLinkTarget } from "@/lib/statute-route";
import { createStatuteLinkTarget } from "@/lib/statute-route";

/**
 * The statutes a decision applies, as the decision itself states them.
 *
 * Closed until asked for: the references are a reading aid beside the
 * decision, and resolving the cited works to their acts is a read.
 */
export const ProvisionsCited = ({
  decisionDate,
  decisionId,
  isHydrated,
}: {
  decisionDate: Date | string | null;
  decisionId: SafeId<"caseLawDecision">;
  isHydrated?: boolean;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const renderPart = useProvisionPartRenderer();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(decisionProvisionsInfiniteOptions(decisionId));

  const groups = groupProvisionsByWork(
    optionalArray(data?.pages).flatMap((page) => page.items),
  );

  // Each work is read at the version its references state, and at the
  // decision's date otherwise; every work on the panel resolves in one read.
  const decisionAsOf = decisionDateToIso(decisionDate);
  const citedWorkByGroup = new Map<string, CitedWorkAtDate>();
  for (const group of groups) {
    const asOf =
      group.provisions.find((provision) => provision.versionValidFrom !== null)
        ?.versionValidFrom ?? decisionAsOf;
    if (group.workEli !== null && asOf !== null) {
      citedWorkByGroup.set(group.key, {
        asOf,
        country: group.jurisdiction,
        eli: group.workEli,
      });
    }
  }
  const { data: resolved } = useQuery({
    ...statutesResolveOptions([...citedWorkByGroup.values()]),
    enabled: open && citedWorkByGroup.size > 0,
  });
  const statuteByWork = statuteByCitedWork(resolved);

  // Absent is the answer for a decision that applies no provisions. A failed
  // read is not that answer, so it keeps the panel and says so instead of
  // disappearing as though the decision cited nothing. Until hydrated the
  // panel is absent either way: the non-blocking prefetch may be known on
  // one side of hydration and not the other.
  const environmentHydrated = useHydrated();
  const hydrated = isHydrated ?? environmentHydrated;
  if (!hydrated || (groups.length === 0 && !isError)) {
    return null;
  }

  return (
    <section className="reader-chrome border-border/60 mb-6 rounded-lg border print:hidden">
      <button
        aria-expanded={open}
        className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-medium"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {t("caseLaw.viewer.provisionsCited")}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {isError && (
            <div className="flex items-center gap-2">
              <p className="text-muted-foreground text-xs">
                {t("errors.actionFailed")}
              </p>
              <Button
                onClick={() => {
                  detached(refetch(), "case-law.provisions-retry");
                }}
                size="sm"
                variant="ghost"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {groups.map((group) => {
            const citedWork = citedWorkByGroup.get(group.key);

            return (
              <WorkReferences
                group={group}
                key={group.key}
                renderPart={renderPart}
                statute={
                  citedWork === undefined
                    ? undefined
                    : statuteByWork.get(citedWorkAtDateKey(citedWork))
                }
              />
            );
          })}
          {hasNextPage && (
            <Button
              className="w-fit"
              disabled={isFetchingNextPage}
              onClick={() => {
                detached(fetchNextPage(), "case-law.provisions-more");
              }}
              size="sm"
              variant="ghost"
            >
              {t("common.loadMore")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
};

const WorkReferences = ({
  group,
  renderPart,
  statute,
}: {
  group: WorkGroup;
  renderPart: RenderProvisionPart;
  /** The work's resolved consolidation; absent while unread or unheld. */
  statute: ResolvedCitedStatute | undefined;
}) => {
  const { data: versions } = useQuery({
    ...statuteVersionsOptions(statute?.id ?? ""),
    enabled:
      statute !== undefined &&
      referencesOutsideVersion(statute, group.provisions),
  });

  /**
   * The consolidation a reference was made against, or null while it is not
   * known to be held.
   *
   * A reference that states a version has to reach that version: the current
   * wording is a different text, and may not even carry the anchor. Until the
   * matching consolidation resolves — the read is in flight, it failed, or
   * the corpus does not hold that version — the reference reads as text
   * rather than linking somewhere it does not belong.
   */
  const documentFor = (provision: ProvisionGroup) => {
    if (statute === undefined) {
      return null;
    }

    if (provision.versionValidFrom === null) {
      return statute;
    }

    // The wording in force is itself the cited version for most references,
    // which is why the versions read is not started for them.
    if (versionCoversDate(statute, provision.versionValidFrom)) {
      return statute;
    }

    return pickVersionAt(optionalArray(versions), provision.versionValidFrom);
  };

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-[calc(0.7rem*var(--reader-text-scale))] tracking-wide">
        <BidiText as="span" className="shrink-0">
          {group.title}
        </BidiText>
        {/* The act's name once its record is in: a number alone asks the
            reader to know that 89/2012 Sb. is the civil code. */}
        {statute !== undefined && (
          <BidiText as="span" className="truncate" title={statute.title}>
            {statute.title}
          </BidiText>
        )}
      </p>
      {/* References flow like prose: a code's thirty sections read on three
          lines, not thirty. A reference showing its passages takes the row. */}
      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0">
        {group.provisions.map((provision) => {
          const document = documentFor(provision);

          return (
            <ProvisionRowItem
              key={provision.key}
              linkTarget={
                document === null
                  ? null
                  : createStatuteLinkTarget({
                      country: document.country,
                      documentId: document.id,
                      eli: document.eli,
                      slug: document.slug,
                      versionValidFrom: document.versionValidFrom,
                    })
              }
              provision={provision}
              renderPart={renderPart}
            />
          );
        })}
      </ul>
    </div>
  );
};

/**
 * One provision the decision applies, and — when it applies it more than
 * once — how many times, with the passages behind that count.
 */
const ProvisionRowItem = ({
  linkTarget,
  provision,
  renderPart,
}: {
  linkTarget: StatuteLinkTarget | null;
  provision: ProvisionGroup;
  renderPart: RenderProvisionPart;
}) => {
  const t = useTranslations();
  const [showPassages, setShowPassages] = useState(false);
  const label = formatProvisionReference(provision, renderPart);
  const count = provision.occurrences.length;

  return (
    <li className={cn("flex min-w-0 flex-col", showPassages && "basis-full")}>
      {/* A full reference ("§ 2958 odst. 1 písm. b) bod 2 věta druhá") is
          wider than the inspector's reading column, so the row wraps at its
          spaces instead of scrolling the pane sideways. */}
      <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
        {linkTarget === null ? (
          <span className="text-foreground-strong-muted text-xs">{label}</span>
        ) : (
          <Link
            className="text-primary text-xs hover:underline"
            hash={provision.anchor}
            {...linkTarget}
          >
            {label}
          </Link>
        )}
        {count > 1 && (
          <button
            aria-expanded={showPassages}
            aria-label={t("caseLaw.viewer.provisionMentionsLabel", {
              count,
            })}
            // Coarse pointers get the same 44px box the shared button
            // primitive draws, without the chrome a button would put in a
            // dense list of references.
            className="text-muted-foreground hover:text-foreground relative text-[calc(0.7rem*var(--reader-text-scale))] tabular-nums pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11"
            onClick={() => setShowPassages(!showPassages)}
            type="button"
          >
            {t("caseLaw.viewer.provisionMentions", { count })}
          </button>
        )}
      </span>
      {showPassages && (
        <ul className="border-border/60 m-0 flex list-none flex-col gap-1 border-s ps-2 pt-1 pb-1">
          {provision.occurrences.map((occurrence) => (
            <li
              className="text-muted-foreground text-[calc(0.7rem*var(--reader-text-scale))] leading-snug"
              key={occurrence.spanStart}
            >
              <BidiText as="span">{occurrence.sentenceText}</BidiText>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

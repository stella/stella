import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { provisionVersionAsOf } from "@stll/api-contract/provision-version-basis";
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { ChevronRightIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { ProvisionVersionBasisLabel } from "@/components/provision-version-basis";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { ProvisionReferenceChip } from "@/features/case-law/components/case-viewer/provision-reference-chip";
import {
  groupProvisionsByWork,
  summarizeProvisionVersions,
  type ProvisionGroup,
  type WorkGroup,
} from "@/features/case-law/components/case-viewer/provisions-cited.logic";
import type { RenderProvisionPart } from "@/features/case-law/provision-label";
import { formatProvisionReference } from "@/features/case-law/provision-label";
import {
  citedWorkAtDateKey,
  decisionProvisionsInfiniteOptions,
  publisherInconsistentCitedWorks,
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
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

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
  expanded,
}: {
  decisionDate: string | null;
  decisionId: SafeId<"caseLawDecision">;
  isHydrated?: boolean;
  /** The compact inspector owns the one disclosure around all citation lists. */
  expanded?: boolean;
}) => {
  const t = useTranslations();
  const [localOpen, setLocalOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(
    () => new Set<string>(),
  );
  const open = expanded ?? localOpen;
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
  const expandedGroups = groups
    .filter(({ key }) => !collapsedGroups.has(key))
    .map(({ key }) => key);

  // Existing links select an inferred version at the decision date;
  // every work on the panel resolves in one read.
  const decisionAsOf = decisionDateToIso(decisionDate);
  const citedWorkByGroup = new Map<string, CitedWorkAtDate>();
  for (const group of groups) {
    const asOf =
      group.provisions
        .map((provision) => provisionVersionAsOf(provision, decisionAsOf))
        .find((date) => date !== null) ?? null;
    if (group.workEli !== null && asOf !== null) {
      citedWorkByGroup.set(group.key, {
        asOf,
        country: group.jurisdiction,
        eli: group.workEli,
      });
    }
  }
  const resolvedQuery = useQuery({
    ...statutesResolveOptions([...citedWorkByGroup.values()]),
    enabled: open && citedWorkByGroup.size > 0,
  });
  const resolvedView = useQueryView(resolvedQuery);
  useQueryViewError(resolvedView);
  const resolved =
    resolvedView.type === "items" ? resolvedView.items : undefined;
  const statuteByWork = statuteByCitedWork(resolved);
  const inconsistentWorks = publisherInconsistentCitedWorks(resolved);

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

  const content = open ? (
    <div
      className={cn(
        "flex flex-col gap-3",
        expanded === undefined && "px-3 pb-3",
      )}
    >
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
      <Accordion
        multiple
        value={expandedGroups}
        onValueChange={(values) => {
          setCollapsedGroups(
            new Set(
              groups
                .filter(({ key }) => !values.includes(key))
                .map(({ key }) => key),
            ),
          );
        }}
      >
        {groups.map((group) => {
          const citedWork = citedWorkByGroup.get(group.key);
          return (
            <WorkReferences
              decisionAsOf={decisionAsOf}
              group={group}
              key={group.key}
              publisherInconsistent={
                citedWork !== undefined &&
                inconsistentWorks.has(citedWorkAtDateKey(citedWork))
              }
              renderPart={renderPart}
              statute={
                citedWork === undefined
                  ? undefined
                  : statuteByWork.get(citedWorkAtDateKey(citedWork))
              }
            />
          );
        })}
      </Accordion>
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
  ) : null;

  if (expanded !== undefined) {
    if (!open) {
      return null;
    }
    return (
      <section className="flex flex-col gap-2">
        <h3 className="text-foreground-strong-muted text-xs font-medium">
          {t("caseLaw.viewer.provisionsCited")}
        </h3>
        {content}
      </section>
    );
  }

  return (
    <section className="reader-chrome border-border/60 mb-6 rounded-lg border print:hidden">
      <button
        aria-expanded={open}
        className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-medium"
        onClick={() => setLocalOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {t("caseLaw.viewer.provisionsCited")}
      </button>
      {content}
    </section>
  );
};

const WorkReferences = ({
  decisionAsOf,
  group,
  publisherInconsistent,
  renderPart,
  statute,
}: {
  decisionAsOf: string | null;
  group: WorkGroup;
  /**
   * Whether the publisher's own inconsistent dates leave the cited date
   * without an in-force reading: the references stay unlinked, and say why.
   */
  publisherInconsistent: boolean;
  renderPart: RenderProvisionPart;
  /** The work's resolved consolidation; absent while unread or unheld. */
  statute: ResolvedCitedStatute | undefined;
}) => {
  const t = useTranslations();
  const versionsQuery = useQuery({
    ...statuteVersionsOptions(statute?.id ?? ""),
    enabled:
      statute !== undefined &&
      referencesOutsideVersion(statute, {
        decisionAsOf,
        references: group.provisions,
      }),
  });
  const versionsView = useQueryView(versionsQuery);
  useQueryViewError(versionsView);
  const versions =
    versionsView.type === "items" ? versionsView.items : undefined;

  /**
   * The consolidation a reference was made against, or null while it is not
   * known to be held.
   *
   * A reference that selects a version has to reach that version: the current
   * wording is a different text, and may not even carry the anchor. Until the
   * matching consolidation resolves — the read is in flight, it failed, or
   * the corpus does not hold that version — the reference reads as text
   * rather than linking somewhere it does not belong.
   */
  const documentFor = (provision: ProvisionGroup) => {
    if (statute === undefined) {
      return null;
    }
    const asOf = provisionVersionAsOf(provision, decisionAsOf);
    if (asOf === null) {
      return null;
    }

    // The wording in force is the inferred version for most references,
    // which is why the versions read is not started for them.
    if (versionCoversDate(statute, asOf)) {
      return statute;
    }

    return pickVersionAt(optionalArray(versions), asOf);
  };

  const { basis, exceptions } = summarizeProvisionVersions(group.provisions);
  let title = group.title;
  if (statute !== undefined) {
    title = statute.title.includes(group.title)
      ? statute.title
      : `${group.title}, ${statute.title}`;
  }

  return (
    <AccordionItem value={group.key}>
      {statute !== undefined &&
        referencesOutsideVersion(statute, {
          decisionAsOf,
          references: group.provisions,
        }) && <QueryViewFeedback view={versionsView} />}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        <AccordionTrigger className="min-w-0 flex-1" size="compact">
          <BidiText as="span" className="min-w-0 text-pretty">
            {title}
          </BidiText>
        </AccordionTrigger>
        <Button
          className="max-w-full text-start"
          size="xs"
          variant="muted"
          data-version-basis="group"
          tooltip={
            basis.type === "inferred" ? (
              t("caseLaw.viewer.versionBasisInferredExplanation")
            ) : (
              <ProvisionVersionBasisLabel basis={basis} />
            )
          }
        >
          <ProvisionVersionBasisLabel basis={basis} compact />
        </Button>
      </div>
      <AccordionPanel size="compact">
        {statute === undefined && publisherInconsistent && (
          <p className="text-muted-foreground mb-2 text-xs">
            {t("statutes.publisherWindowInconsistent")}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {group.provisions.map((provision) => (
            <ProvisionReferenceChip
              document={documentFor(provision)}
              key={provision.key}
              label={formatProvisionReference(provision, renderPart)}
              provision={provision}
              versionMarker={
                exceptions.has(provision.key) ? "exception" : "group"
              }
            />
          ))}
        </div>
      </AccordionPanel>
    </AccordionItem>
  );
};

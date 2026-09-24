import type { RefObject } from "react";

import { useQuery } from "@tanstack/react-query";

import type { Block } from "@stll/legal-ast/document-ast";

import { SourceLinkPolicyProvider } from "@/components/legal-reader/source-link-policy";
import { AnnotatedStatuteText } from "@/features/statutes/components/annotated-statute-text";
import { statuteCitationCountsOptions } from "@/features/statutes/queries/citing-decisions";
import type { PublicStatute } from "@/features/statutes/queries/statutes";
import { provisionCitationCountByBlockAnchor } from "@/features/statutes/statute-reader-blocks";
import type { StatuteMasthead } from "@/features/statutes/statute-reader-blocks";

type StatuteReaderBodyProps = {
  /** Parsed blocks. The caller owns the parse: the page also builds an outline. */
  blocks: readonly Block[];
  /** The rendered block the reader was sent to, if any. */
  landingAnchorId?: string | undefined;
  masthead: StatuteMasthead | null;
  scrollContainerRef: RefObject<HTMLElement | null>;
  statute: PublicStatute;
  /** A Work with a single consolidation has no history to offer. */
  versionCount: number;
};

/**
 * One consolidation's wording, with the citations its provisions carry.
 *
 * The scroll container is the caller's, because the two readers scroll
 * differently: the page scrolls its whole column, the inspector pane scrolls
 * inside the pane.
 */
export const StatuteReaderBody = ({
  blocks,
  landingAnchorId,
  masthead,
  scrollContainerRef,
  statute,
  versionCount,
}: StatuteReaderBodyProps) => {
  // The keys a provision's incoming citations are filed under. Both come off
  // the document itself: nothing about the work is inferred here.
  const eli = statute.eli.trim();
  const jurisdiction = statute.country.trim().toUpperCase();
  const citationWork =
    eli === "" || jurisdiction === "" ? null : { eli, jurisdiction };
  const citationCounts = useQuery({
    ...statuteCitationCountsOptions(
      citationWork ?? { eli: "", jurisdiction: "" },
    ),
    enabled:
      citationWork !== null && typeof statute.citationCaseCount === "number",
  });
  const provisionCitationCounts = provisionCitationCountByBlockAnchor(
    blocks,
    citationCounts.data?.status === "ready"
      ? citationCounts.data.provisions
      : [],
  );

  return (
    // The act's own publisher is the only host its markup may link to; a
    // consolidation typeset with links into a commercial database renders
    // those references as text, or as our own statute link.
    <SourceLinkPolicyProvider urls={[statute.documentUrl, statute.sourceUrl]}>
      <AnnotatedStatuteText
        blocks={blocks}
        citationWork={citationWork}
        country={statute.country}
        documentId={statute.id}
        eli={statute.eli}
        fulltext={statute.fulltext}
        landingAnchorId={landingAnchorId}
        language={statute.language}
        masthead={masthead}
        provisionCitationCounts={provisionCitationCounts}
        scrollContainerRef={scrollContainerRef}
        statuteTitle={statute.title}
        versionCount={versionCount}
        versionValidFrom={statute.versionValidFrom}
      />
    </SourceLinkPolicyProvider>
  );
};

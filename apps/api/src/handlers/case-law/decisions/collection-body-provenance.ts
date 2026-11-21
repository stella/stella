import { panic } from "better-result";

import {
  COLLECTION_BODY_EXTENT,
  COLLECTION_PROVENANCE_COVERAGE,
  COLLECTION_PUBLICATION_CONTRIBUTION,
  COLLECTION_PUBLICATION_PROJECTION_MAX,
  DECISION_BODY_TEXT_SOURCE,
} from "@stll/api-contract/case-law-body-source";
import type {
  CollectionContextLayout,
  CollectionPublicationProvenance,
  DecisionBodySource,
} from "@stll/api-contract/case-law-body-source";

import { sortDeep } from "@/api/lib/sort-deep";

import type { CollectionPublication } from "./compose-collection-document";

type Contribution = CollectionPublicationProvenance["contribution"];
type BodyPublicationProvenance = CollectionPublicationProvenance & {
  contribution: typeof COLLECTION_PUBLICATION_CONTRIBUTION.BODY;
};

/** Public attribution excludes the retained headnote and all private payload locators. */
export const publicationProvenanceOf = <
  const TContribution extends Contribution,
>(
  {
    source,
    sourceDocumentId,
    sourceUrl,
    retrievedAt,
    documentPart,
  }: CollectionPublication,
  contribution: TContribution,
  contextLayout?: CollectionContextLayout,
): CollectionPublicationProvenance & { contribution: TContribution } => {
  const common = {
    source,
    sourceDocumentId,
    sourceUrl,
    retrievedAt,
    contribution,
  };
  switch (documentPart.extent) {
    case "complete":
      return { extent: COLLECTION_BODY_EXTENT.COMPLETE, ...common };
    case "section":
      return {
        extent: COLLECTION_BODY_EXTENT.SECTION,
        sectionNumber: documentPart.sectionNumber,
        collectionLabel: documentPart.collectionLabel,
        ...(contextLayout === undefined ? {} : { contextLayout }),
        ...common,
      };
    case "unclassified":
      return { extent: COLLECTION_BODY_EXTENT.UNCLASSIFIED, ...common };
    default:
      documentPart satisfies never;
      return panic("Unhandled collection publication extent");
  }
};

const publicationKey = ({
  source,
  sourceDocumentId,
  sourceUrl,
}: CollectionPublicationProvenance) =>
  JSON.stringify([
    source.id,
    sourceDocumentId,
    sourceDocumentId === null ? sourceUrl : null,
  ]);

const publicationContents = ({
  contribution: _contribution,
  ...contents
}: CollectionPublicationProvenance) => JSON.stringify(sortDeep(contents));

type CollectionBodySourceOptions = {
  primary: BodyPublicationProvenance;
  publications: readonly CollectionPublicationProvenance[];
  /** The exact count before the reader's bounded metadata projection. */
  totalCount: number;
};

/** Every served publication stays attributed; only related records may be omitted. */
export const collectionBodySourceOf = ({
  primary,
  publications,
  totalCount,
}: CollectionBodySourceOptions): Extract<
  DecisionBodySource,
  { textSource: "collection" }
> => {
  const recordsByKey = new Map<string, CollectionPublicationProvenance>();
  for (const publication of [primary, ...publications]) {
    const key = publicationKey(publication);
    const previous = recordsByKey.get(key);
    if (
      previous !== undefined &&
      publicationContents(previous) !== publicationContents(publication)
    ) {
      return panic("One collection publication has conflicting provenance");
    }
    if (previous?.contribution !== COLLECTION_PUBLICATION_CONTRIBUTION.BODY) {
      recordsByKey.set(key, publication);
    }
  }
  const retained = [...recordsByKey.values()];
  if (!Number.isSafeInteger(totalCount) || totalCount < retained.length) {
    return panic(
      "Collection provenance count is smaller than its retained records",
    );
  }
  const served = retained.filter(
    ({ contribution }) =>
      contribution === COLLECTION_PUBLICATION_CONTRIBUTION.BODY,
  );
  if (served.length > COLLECTION_PUBLICATION_PROJECTION_MAX) {
    return panic(
      "A collection read selected more bodies than it can attribute",
    );
  }
  const related = retained.filter(
    ({ contribution }) =>
      contribution === COLLECTION_PUBLICATION_CONTRIBUTION.RELATED,
  );
  const records = [...served, ...related].slice(
    0,
    COLLECTION_PUBLICATION_PROJECTION_MAX,
  );
  const omittedCount = totalCount - records.length;
  const provenance =
    omittedCount === 0
      ? {
          coverage: COLLECTION_PROVENANCE_COVERAGE.ALL,
          totalCount,
          omittedCount: 0 as const,
          records,
        }
      : {
          coverage: COLLECTION_PROVENANCE_COVERAGE.TRUNCATED,
          totalCount,
          omittedCount,
          records,
        };
  return {
    textSource: DECISION_BODY_TEXT_SOURCE.COLLECTION,
    source: primary.source,
    sourceUrl: primary.sourceUrl,
    retrievedAt: primary.retrievedAt,
    extent: primary.extent,
    provenance,
  };
};

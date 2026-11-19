import { panic, Result, TaggedError } from "better-result";

import type { DecisionBodySource } from "@stll/api-contract/case-law-body-source";
import { compareCodeUnit } from "@stll/collation";
import { declareFingerprintFields } from "@stll/errors";
import type { Block, DecisionMetadata } from "@stll/legal-ast/document-ast";
import {
  hasUsableAst,
  withUniqueBlockIdentities,
} from "@stll/legal-ast/document-ast";

import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import type { CollectionDocumentPartRead } from "@/api/lib/legal-search/collection-document-part-read";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
import { payloadCarriesDocument } from "@/api/lib/legal-search/corpus-content-hash";
import { sortDeep } from "@/api/lib/sort-deep";

type CollectionSource = Extract<
  DecisionBodySource,
  { textSource: "collection" }
>["source"];

export type CollectionPublication = {
  source: CollectionSource;
  sourceDocumentId: string | null;
  sourceUrl: string;
  retrievedAt: string | null;
  documentPart: CollectionDocumentPartRead;
};

type SectionPublication = CollectionPublication & {
  documentPart: Extract<CollectionDocumentPartRead, { extent: "section" }>;
};
type CompletePublication = CollectionPublication & {
  documentPart: Extract<CollectionDocumentPartRead, { extent: "complete" }>;
};
type UnclassifiedPublication = CollectionPublication & {
  documentPart: Extract<CollectionDocumentPartRead, { extent: "unclassified" }>;
};

export type CollectionDocumentPlan =
  | { extent: "complete"; publications: readonly [CompletePublication] }
  | {
      extent: "section";
      publications: readonly [SectionPublication, ...SectionPublication[]];
    }
  | {
      extent: "unclassified";
      publications: readonly [UnclassifiedPublication];
    };

const completePublication = (
  publication: CollectionPublication,
): publication is CompletePublication =>
  publication.documentPart.extent === "complete";
const sectionPublication = (
  publication: CollectionPublication,
): publication is SectionPublication =>
  publication.documentPart.extent === "section";
const unclassifiedPublication = (
  publication: CollectionPublication,
): publication is UnclassifiedPublication =>
  publication.documentPart.extent === "unclassified";

const publicationKey = ({
  source,
  sourceDocumentId,
  sourceUrl,
}: CollectionPublication) =>
  JSON.stringify([
    source.id,
    sourceDocumentId,
    sourceDocumentId === null ? sourceUrl : null,
  ]);

/** Select before object reads: an explicit whole edition needs no partial payloads. */
export const planCollectionDocument = (
  publications: readonly CollectionPublication[],
): CollectionDocumentPlan | null => {
  const ordered = publications.toSorted((left, right) =>
    compareCodeUnit(publicationKey(left), publicationKey(right)),
  );
  const complete = ordered.find(completePublication);
  if (complete !== undefined) {
    return { extent: "complete", publications: [complete] };
  }
  const sections = ordered.filter(sectionPublication);
  const firstSection = sections.at(0);
  if (firstSection !== undefined) {
    const [first, ...rest] = sections
      .filter(
        ({ source, documentPart }) =>
          source.id === firstSection.source.id &&
          documentPart.collectionLabel ===
            firstSection.documentPart.collectionLabel,
      )
      .toSorted(
        (left, right) =>
          left.documentPart.sectionNumber - right.documentPart.sectionNumber ||
          compareCodeUnit(publicationKey(left), publicationKey(right)),
      );
    if (first === undefined) {
      return panic("Lost the selected collection section group");
    }
    return { extent: "section", publications: [first, ...rest] };
  }
  const unclassified = ordered.find(unclassifiedPublication);
  return unclassified === undefined
    ? null
    : { extent: "unclassified", publications: [unclassified] };
};

export class CollectionDocumentCompositionError extends TaggedError(
  "CollectionDocumentCompositionError",
)<{
  message: string;
  reason:
    | "missing-publication"
    | "duplicate-publication"
    | "invalid-section"
    | "common-context-conflict"
    | "section-conflict"
    | "empty-complete"
    | "document-kind";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export type LoadedCollectionPublication = {
  publication: CollectionPublication;
  payload: CorpusPayload;
};

type CollectionDecisionIdentity = Pick<
  DecisionMetadata,
  "caseNumber" | "ecli" | "court" | "decisionDate" | "decisionType"
>;

type ComposedCollectionDocument = {
  plan: CollectionDocumentPlan;
  payload: CorpusPayload;
};

type ComposeCollectionDocumentOptions = {
  decisionId: string;
  identity: CollectionDecisionIdentity;
  publications: readonly LoadedCollectionPublication[];
};

// Block identities are local to a post; every other semantic field must agree.
const commonBlockKey = ({ id: _id, anchorId: _anchorId, ...content }: Block) =>
  JSON.stringify(sortDeep(content));

const sameBlocks = (left: readonly Block[], right: readonly Block[]) =>
  left.length === right.length &&
  left.every((block, index) => {
    const other = right.at(index);
    return (
      other !== undefined && commonBlockKey(block) === commonBlockKey(other)
    );
  });

/** Parts are retained snapshots, never publisher calls or inferred missing sections. */
export const composeCollectionDocument = ({
  decisionId,
  identity,
  publications,
}: ComposeCollectionDocumentOptions): Result<
  ComposedCollectionDocument,
  CollectionDocumentCompositionError
> => {
  const byKey = new Map(
    publications.map((loaded) => [publicationKey(loaded.publication), loaded]),
  );
  if (byKey.size !== publications.length) {
    return Result.err(
      new CollectionDocumentCompositionError({
        message: "A collection publication was supplied more than once",
        reason: "duplicate-publication",
      }),
    );
  }
  const plan = planCollectionDocument(
    publications.map(({ publication }) => publication),
  );
  if (plan === null) {
    return Result.err(
      new CollectionDocumentCompositionError({
        message: "No collection publication was supplied",
        reason: "missing-publication",
      }),
    );
  }
  const loadedOf = (publication: CollectionPublication) =>
    byKey.get(publicationKey(publication)) ??
    panic("Lost a selected collection payload");
  switch (plan.extent) {
    case "complete": {
      const { payload } = loadedOf(plan.publications[0]);
      return payloadCarriesDocument(payload)
        ? Result.ok({ plan, payload })
        : Result.err(
            new CollectionDocumentCompositionError({
              message: "An explicit complete edition has no retained body",
              reason: "empty-complete",
            }),
          );
    }
    case "unclassified":
      return Result.ok({
        plan,
        payload: loadedOf(plan.publications[0]).payload,
      });
    case "section": {
      const fragments = [];
      for (const publication of plan.publications) {
        const { payload } = loadedOf(publication);
        const { firstBlock, afterLastBlock } = publication.documentPart;
        if (
          !hasUsableAst(payload.ast) ||
          firstBlock >= afterLastBlock ||
          afterLastBlock > payload.ast.blocks.length
        ) {
          return Result.err(
            new CollectionDocumentCompositionError({
              message:
                "Collection offsets do not select retained document blocks",
              reason: "invalid-section",
            }),
          );
        }
        if (payload.ast.metadata.type === "guidance") {
          return Result.err(
            new CollectionDocumentCompositionError({
              message:
                "A collection section does not contain decision metadata",
              reason: "document-kind",
            }),
          );
        }
        fragments.push({
          publication,
          statutes: payload.ast.metadata.statutes,
          prefix: payload.ast.blocks.slice(0, firstBlock),
          section: payload.ast.blocks.slice(firstBlock, afterLastBlock),
          suffix: payload.ast.blocks.slice(afterLastBlock),
        });
      }
      const first = fragments.at(0) ?? panic("Selected no collection sections");
      if (
        fragments.some(
          ({ prefix, suffix }) =>
            !sameBlocks(first.prefix, prefix) ||
            !sameBlocks(first.suffix, suffix),
        )
      ) {
        return Result.err(
          new CollectionDocumentCompositionError({
            message:
              "Collection parts disagree about their shared document context",
            reason: "common-context-conflict",
          }),
        );
      }
      const sections = new Map<number, readonly Block[]>();
      for (const { publication, section } of fragments) {
        const ordinal = publication.documentPart.sectionNumber;
        const previous = sections.get(ordinal);
        if (previous !== undefined && !sameBlocks(previous, section)) {
          return Result.err(
            new CollectionDocumentCompositionError({
              message: "Collection posts disagree about one printed section",
              reason: "section-conflict",
            }),
          );
        }
        sections.set(ordinal, section);
      }
      const blocks = withUniqueBlockIdentities([
        ...first.prefix,
        ...[...sections.values()].flat(),
        ...first.suffix,
      ]);
      return Result.ok({
        plan,
        payload: {
          text: blocks.map(({ plainText }) => plainText).join("\n\n"),
          sections: sectionsFromAst(blocks),
          ast: {
            version: 1,
            source: {
              system: "collection-document-composition",
              documentId: decisionId,
              webUrl: "",
              printUrl: "",
            },
            metadata: {
              caseNumber: identity.caseNumber,
              ecli: identity.ecli,
              court: identity.court,
              decisionDate: identity.decisionDate,
              decisionType: identity.decisionType,
              keywords: [
                ...new Set(
                  plan.publications.flatMap(
                    ({ documentPart }) => documentPart.keywords,
                  ),
                ),
              ],
              statutes: [
                ...new Set(fragments.flatMap(({ statutes }) => statutes)),
              ],
            },
            blocks,
          },
        },
      });
    }
    default:
      plan satisfies never;
      return panic("Unhandled collection document plan");
  }
};

import { panic, TaggedError } from "better-result";

import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  corpusIndexFastFields,
  corpusIndexPublisherFields,
  corpusIndexStemFields,
  requireCorpusIndexManifest,
  type CorpusIndexPublisherFields,
  type CorpusIndexStemFields,
} from "@/api/lib/legal-search/corpus-index-manifest";
import type { CorpusStemming } from "@/api/lib/legal-search/corpus-query";
import {
  corpusMorphologyLanguage,
  documentMorphologyLanguage,
} from "@/api/lib/legal-search/morphology/corpus-language";

/**
 * The serving case-law generation cannot answer a case-law read: its index
 * mapping does not support what the read contract requires. A configuration
 * failure, not a request one — the deployment is pointed at a generation
 * built before the contract — so it names the generation and the field.
 */
export class CorpusIndexReadContractError extends TaggedError(
  "CorpusIndexReadContractError",
)<{
  message: string;
}> {}

export type CaseLawIndexReadContract = {
  family: "case_law";
  openingPassageQuery: string;
  yearFacetField: string;
  /**
   * The stem companions this generation maps, or null. The query builder may
   * name a field only when it appears here: the case-law doc mapping is
   * `strict`, so a clause over a field the index never declared is not a
   * narrower query but an invalid one.
   */
  stemFields: CorpusIndexStemFields | null;
  /**
   * Full-text fields this generation maps beside the ones a bare term already
   * reaches. Named explicitly by a query or not matched at all.
   */
  searchableFields: readonly string[];
  /**
   * The publisher's classification, kept apart from the fields above rather
   * than listed with them: it is the newest and weakest of a query's
   * alternatives, and the leaf budget pays for it only after every token's
   * stems and older alternatives, so naming it can never cost a query the
   * matches it had without it.
   */
  keywordFields: readonly string[];
};

type PublisherQueryFields = Pick<
  CaseLawIndexReadContract,
  "searchableFields" | "keywordFields"
>;

/**
 * The publisher fields of a generation, as the lists a query may name them
 * in. Both are matched only where a clause asks for them; what a bare term
 * reaches is the index's own decision and neither is part of it. One switch
 * answers for both, so the two lists cannot drift into disagreeing about what
 * a generation maps.
 */
const publisherQueryFields = (
  publisher: CorpusIndexPublisherFields,
): PublisherQueryFields => {
  switch (publisher.kind) {
    case "none":
      return { searchableFields: [], keywordFields: [] };
    case "summary":
      return {
        searchableFields: [publisher.summaryField],
        keywordFields: [],
      };
    case "summary_and_keywords":
      return {
        searchableFields: [publisher.summaryField],
        keywordFields: [publisher.keywordsField],
      };
    default:
      publisher satisfies never;
      return panic(`Unhandled publisher fields: ${String(publisher)}`);
  }
};

/**
 * The field a case-law search counts distinct decisions by, proven
 * aggregatable.
 *
 * The index unit is a passage, so every number that describes decisions — a
 * facet bucket, a result total — is a cardinality over the document id, and an
 * aggregation reads a columnar store, which only a fast field has. A
 * generation that does not mark it fast can therefore report passage counts or
 * nothing, and the first is worse: a filter rail of plausible, wrong numbers
 * next to every court.
 *
 * So this is an assertion, not a capability check. A search asks once, before
 * any engine work, and a deployment pointed at such a generation fails every
 * case-law corpus search loudly instead of serving one.
 */
export const requireCaseLawDecisionCountField = (
  generation: string,
): string => {
  const manifest = requireCorpusIndexManifest("case_law", generation);
  const field = manifest.projection.documentIdField;
  if (corpusIndexFastFields(manifest).has(field)) {
    return field;
  }
  throw new CorpusIndexReadContractError({
    message: `Generation ${manifest.generation} does not mark ${field} fast, so a search cannot count decisions`,
  });
};

export type LegislationIndexReadContract = {
  family: "legislation";
  openingPassageQuery: string;
};

export type CorpusIndexReadContract =
  | CaseLawIndexReadContract
  | LegislationIndexReadContract;

/**
 * Query capabilities owned by a generation's physical schema. Every field name
 * is derived from the generation's immutable manifest, so readers cannot drift
 * from writers when a generation changes shape.
 */
export function corpusIndexReadContract(
  family: "case_law",
  generation: string,
): CaseLawIndexReadContract;
export function corpusIndexReadContract(
  family: "legislation",
  generation: string,
): LegislationIndexReadContract;
export function corpusIndexReadContract(
  family: CorpusFamily,
  generation: string,
): CorpusIndexReadContract;
export function corpusIndexReadContract(
  family: CorpusFamily,
  generation: string,
): CorpusIndexReadContract {
  const manifest = requireCorpusIndexManifest(family, generation);
  switch (manifest.family) {
    case "case_law":
      return {
        family: manifest.family,
        openingPassageQuery: `${manifest.projection.openingField}:true`,
        yearFacetField: manifest.projection.yearFacetField,
        stemFields: corpusIndexStemFields(manifest),
        ...publisherQueryFields(corpusIndexPublisherFields(manifest)),
      };
    case "legislation":
      return {
        family: manifest.family,
        openingPassageQuery: `${manifest.projection.openingField}:true`,
      };
    default:
      manifest satisfies never;
      return panic(`Unhandled manifest: ${String(manifest)}`);
  }
}

type CaseLawCorpusQueryFieldsOptions = {
  generation: string;
  /** The query's jurisdiction, or undefined for an unscoped search. */
  jurisdiction: string | undefined;
  /** The request's language filter, when it carries one. */
  language: string | undefined;
};

export type CaseLawCorpusQueryFields = {
  surfaceFields: readonly string[];
  keywordFields: readonly string[];
  stemming: CorpusStemming | null;
};

/**
 * Which fields beyond the default ones a case-law query may name, and under
 * which language its words are stemmed.
 *
 * Both read paths resolve it here rather than each assembling its own answer,
 * for the same reason both assemble their query through one builder: two
 * answers to what the engine sees is the failure this indirection exists to
 * prevent. A generation that maps nothing extra yields the query it yields
 * today.
 *
 * The stemming language comes from the request's `language` filter first,
 * because that filter names the documents whose stems are being matched: a
 * search scoped to `EU` but filtered to Czech text has to stem Czech, and a
 * filter with no country at all has no jurisdiction to fall back on. Only when
 * the request names no language does the jurisdiction answer, and an unscoped
 * search — spanning every jurisdiction of a generation — answers with none.
 * A language filter naming text no stemmer covers yields no stemming rather
 * than the jurisdiction's, which would stem the reader's words against a
 * language the documents are not written in.
 */
export const caseLawCorpusQueryFields = ({
  generation,
  jurisdiction,
  language,
}: CaseLawCorpusQueryFieldsOptions): CaseLawCorpusQueryFields => {
  const { stemFields, searchableFields, keywordFields } =
    corpusIndexReadContract("case_law", generation);
  const stemLanguage =
    language === undefined
      ? corpusMorphologyLanguage(jurisdiction)
      : documentMorphologyLanguage(language);
  return {
    surfaceFields: searchableFields,
    keywordFields,
    stemming:
      stemFields === null || stemLanguage === null
        ? null
        : {
            language: stemLanguage,
            fields: [stemFields.text, stemFields.publisherSummary],
          },
  };
};

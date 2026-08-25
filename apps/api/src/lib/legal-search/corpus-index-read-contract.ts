import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { corpusIndexClusterForGeneration } from "@/api/lib/legal-search/corpus-generation-contract";
import { requireCorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";

type CaseLawIndexReadContract = {
  family: "case_law";
  openingPassageQuery: string;
  yearFacetField: string;
};

type LegislationIndexReadContract = {
  family: "legislation";
  openingPassageQuery: string;
};

export type CorpusIndexReadContract =
  | CaseLawIndexReadContract
  | LegislationIndexReadContract;

/**
 * Query capabilities owned by a generation's physical schema. Legacy q08
 * generations share their established fields; final q09 generations derive
 * every field name from the immutable manifest so readers cannot drift from
 * writers when a generation changes shape.
 */
export const corpusIndexReadContract = (
  family: CorpusFamily,
  generation: string,
): CorpusIndexReadContract => {
  const cluster = corpusIndexClusterForGeneration(family, generation);
  if (cluster === "q08") {
    return family === "case_law"
      ? {
          family,
          openingPassageQuery: "seq:0",
          yearFacetField: "year",
        }
      : { family, openingPassageQuery: "seq:0" };
  }

  const manifest = requireCorpusIndexManifest(family, generation);
  switch (manifest.family) {
    case "case_law":
      return {
        family: manifest.family,
        openingPassageQuery: `${manifest.projection.openingField}:true`,
        yearFacetField: manifest.projection.yearFacetField,
      };
    case "legislation":
      return {
        family: manifest.family,
        openingPassageQuery: `${manifest.projection.openingField}:true`,
      };
    default:
      return manifest satisfies never;
  }
};

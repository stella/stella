import * as v from "valibot";

import { SOFT_LAW_PERMISSION_GATED_AUTHORITIES } from "@/api/lib/legal-search/soft-law-permission-gated";

/**
 * Regulator guidance sources whose publisher has permitted full-text reuse,
 * comma separated. Only a source served as a listing pending that permission
 * can be named; it then serves and acquires its full texts.
 */
export const softLawFullTextPermittedSourcesSchema = v.optional(
  v.pipe(
    v.string(),
    v.transform((value) =>
      value
        .split(",")
        .map((source) => source.trim())
        .filter((source) => source.length > 0),
    ),
    v.array(v.picklist(SOFT_LAW_PERMISSION_GATED_AUTHORITIES)),
  ),
  "",
);

const softLawEnvironmentSchema = v.object({
  SOFT_LAW_FULL_TEXT_PERMITTED_SOURCES: softLawFullTextPermittedSourcesSchema,
});

/**
 * Reads the permitted sources without validating the whole API environment:
 * the sync script and the read path both consult it, and the script imports
 * ingestion modules without loading the API environment. An empty value
 * counts as unset, as it does in `env`.
 */
export const readSoftLawFullTextPermittedSources = () =>
  v.parse(softLawEnvironmentSchema, {
    SOFT_LAW_FULL_TEXT_PERMITTED_SOURCES:
      process.env["SOFT_LAW_FULL_TEXT_PERMITTED_SOURCES"] || undefined,
  }).SOFT_LAW_FULL_TEXT_PERMITTED_SOURCES;

import * as v from "valibot";

import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";

import { SEARCH_CASE_LAW_PROJECTION } from "../../../lib/chat/case-law-result-projections";

const search = SEARCH_CASE_LAW_PROJECTION.options[1].pipe[0];
const unavailable = v.object(
  v.pick(SEARCH_CASE_LAW_PROJECTION.options[0].pipe[0], ["message", "hint"])
    .entries,
);
const identityFields = [
  "decisionId",
  "court",
  "courtAbbreviation",
  "decisionDate",
  "caseNumber",
  "ecli",
  "appUrl",
  "source_url",
] as const;
export const APP_SEARCH_SCHEMA = v.union([
  unavailable,
  v.object({
    ...v.pick(search, ["nextCursor", "nextStep", "headnotes"]).entries,
    results: v.array(
      v.union([
        v.object(
          v.pick(search.entries.results.item.options[0].pipe[0], [
            ...identityFields,
            "snippet",
            "headnote",
            "keywords",
          ]).entries,
        ),
        v.object(
          v.pick(search.entries.results.item.options[1].pipe[0], [
            ...identityFields,
            "excerpt",
            "headnote",
            "keywords",
          ]).entries,
        ),
      ]),
    ),
    facets: v.nullable(
      v.object({
        court: v.array(
          v.object({
            tierLabel:
              search.entries.facets.wrapped.entries.court.item.entries
                .tierLabel,
            courts: v.array(
              v.object(
                v.pick(
                  search.entries.facets.wrapped.entries.court.item.entries
                    .courts.item,
                  ["value"],
                ).entries,
              ),
            ),
          }),
        ),
      }),
    ),
    searches: v.array(
      v.object({
        warnings: v.array(
          v.object(
            v.pick(search.entries.searches.item.entries.warnings.item, [
              "message",
              "hint",
            ]).entries,
          ),
        ),
      }),
    ),
  }),
]);
export const APP_RESOLVE_SCHEMA = legalResolveResponseSchema;
export type SearchResults = v.InferOutput<typeof APP_SEARCH_SCHEMA>;
export type ResolveResults = v.InferOutput<typeof APP_RESOLVE_SCHEMA>;

export {
  openDecisionOutput as APP_OPEN_DECISION_SCHEMA,
  blocksDecisionOutput as APP_DECISION_BLOCKS_SCHEMA,
  provisionPreviewOutput as APP_PROVISION_PREVIEW_SCHEMA,
} from "../../../lib/chat/decision-reader-projections";

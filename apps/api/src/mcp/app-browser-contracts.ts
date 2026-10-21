import * as v from "valibot";

import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";

import { SEARCH_CASE_LAW_PROJECTION } from "../lib/chat/case-law-result-projections";

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
  "url",
  "source_url",
  "match",
] as const;
export const APP_SEARCH_SCHEMA = v.union([
  unavailable,
  v.object({
    ...v.pick(search, ["nextCursor", "headnotes"]).entries,
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
              "audience",
              "message",
            ]).entries,
          ),
        ),
      }),
    ),
  }),
]);
export const APP_RESOLVE_SCHEMA = legalResolveResponseSchema;

export {
  openDecisionOutput as APP_OPEN_DECISION_SCHEMA,
  blocksDecisionOutput as APP_DECISION_BLOCKS_SCHEMA,
  provisionPreviewOutput as APP_PROVISION_PREVIEW_SCHEMA,
} from "../lib/chat/decision-reader-projections";

export { READ_PROVISION_HISTORY_PROJECTION as APP_PROVISION_HISTORY_SCHEMA } from "../lib/chat/legislation-result-projections";

export { READ_CASE_LAW_CITATIONS_PROJECTION as APP_CITATION_PAGE_SCHEMA } from "../lib/chat/case-law-citation-projection";

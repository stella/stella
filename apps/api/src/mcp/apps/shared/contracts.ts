import * as v from "valibot";

import {
  LOOKUP_CASE_LAW_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
} from "../../../lib/chat/case-law-result-projections";

const search = SEARCH_CASE_LAW_PROJECTION.options[1].pipe[0];
const lookup = LOOKUP_CASE_LAW_PROJECTION.options[1].pipe[0];
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
const lookupOptions = lookup.entries.items.item.options;
const found = lookupOptions[0].pipe[0];
const ambiguous = lookupOptions[1].pipe[0];
const missing = lookupOptions[2].pipe[0];
const failed = lookupOptions[3].pipe[0];

export const APP_SEARCH_SCHEMA = v.union([
  unavailable,
  v.object({
    ...v.pick(search, ["nextCursor", "nextStep", "headnotes"]).entries,
    results: v.array(
      v.object(
        v.pick(search.entries.results.item, [
          ...identityFields,
          "snippet",
          "headnote",
          "keywords",
        ]).entries,
      ),
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
export const APP_LOOKUP_SCHEMA = v.union([
  unavailable,
  v.object({
    items: v.array(
      v.variant("status", [
        v.object(v.pick(found, [...identityFields, "status"]).entries),
        v.object({
          ...v.pick(ambiguous, ["status", "message"]).entries,
          candidates: v.array(
            v.object(
              v.pick(ambiguous.entries.candidates.item, identityFields).entries,
            ),
          ),
        }),
        v.object(v.pick(missing, ["status", "message", "hint"]).entries),
        v.object(v.pick(failed, ["status", "message"]).entries),
      ]),
    ),
  }),
]);
export type SearchResults = v.InferOutput<typeof APP_SEARCH_SCHEMA>;
export type LookupResults = v.InferOutput<typeof APP_LOOKUP_SCHEMA>;

export {
  openDecisionOutput as APP_OPEN_DECISION_SCHEMA,
  blocksDecisionOutput as APP_DECISION_BLOCKS_SCHEMA,
  provisionPreviewOutput as APP_PROVISION_PREVIEW_SCHEMA,
} from "../../../lib/chat/decision-reader-projections";

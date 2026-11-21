import * as v from "valibot";

import type { DecisionSearchFacets } from "@/api/lib/case-law/decision-search-facets";
import type { SEARCH_CASE_LAW_PROJECTION } from "@/api/lib/chat/projections";
import {
  type AssertNoExtraFields,
  projectionPayload,
} from "@/api/lib/projection-totality";

// The whole facet tree is forwarded, including every nested bucket field.
type SearchProjection = Extract<
  v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>,
  { facets: unknown }
>;
type FacetContract = AssertNoExtraFields<
  DecisionSearchFacets | null,
  SearchProjection["facets"]
>;
declare const facets: DecisionSearchFacets | null;
facets satisfies FacetContract;

const schema = v.strictObject({
  items: v.array(v.strictObject({ value: v.string() })),
});
declare const declared: { items: { value: string }[] };
declare const drifted: { items: { value: string; countType: string }[] };
projectionPayload(schema, declared);
// @ts-expect-error nested producer fields must be classified, even through variables
projectionPayload(schema, drifted);
// @ts-expect-error spreads cannot bypass exactness
projectionPayload(schema, { ...drifted });

const branches = v.variant("type", [
  v.strictObject({
    type: v.literal("found"),
    item: v.strictObject({ value: v.string() }),
  }),
  v.strictObject({ type: v.literal("absent") }),
]);
declare const unionDrift:
  | { type: "found"; item: { value: string; extra: string } }
  | { type: "absent" };
// @ts-expect-error one union branch cannot hide another branch's unclassified fields
projectionPayload(branches, unionDrift);

const classified = v.strictObject({
  items: v.array(v.strictObject({ value: v.string(), countType: v.string() })),
});
projectionPayload(classified, drifted);

// Heterogeneous array inference synthesizes optional-never keys on peers.
declare const inferredPeers: { items: { value: string; absent?: never }[] };
projectionPayload(schema, inferredPeers);
declare const presentUndefined: {
  items: { value: string; extra: undefined }[];
};
// @ts-expect-error a required unknown key is still present even with no value
projectionPayload(schema, presentUndefined);
declare const optionalUndefined: {
  items: { value: string; extra?: undefined }[];
};
// @ts-expect-error an optional explicit undefined key is not an absent never key
projectionPayload(schema, optionalUndefined);

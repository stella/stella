import type * as v from "valibot";

import type { MCP_APP_OUTPUT_SCHEMAS } from "../../app-contracts";
import {
  search_case_law as validateSearch,
  lookup_case_law as validateLookup,
} from "./generated/validators.js";

export type SearchResults = v.InferOutput<
  typeof MCP_APP_OUTPUT_SCHEMAS.search_case_law
>;
export type LookupResults = v.InferOutput<
  typeof MCP_APP_OUTPUT_SCHEMAS.lookup_case_law
>;

export const isSearchResults = (value: unknown): value is SearchResults =>
  validateSearch(value);
export const isLookupResults = (value: unknown): value is LookupResults =>
  validateLookup(value);

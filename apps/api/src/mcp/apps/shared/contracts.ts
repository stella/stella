import { Ajv } from "ajv";
import type * as v from "valibot";

import type { MCP_APP_OUTPUT_SCHEMAS } from "../../app-contracts";
import schemas from "./generated/schemas.json";

export type SearchResults = v.InferOutput<
  typeof MCP_APP_OUTPUT_SCHEMAS.search_case_law
>;
export type LookupResults = v.InferOutput<
  typeof MCP_APP_OUTPUT_SCHEMAS.lookup_case_law
>;

const validator = new Ajv({ strict: false, validateFormats: false });
const validateSearch = validator.compile(schemas.search_case_law);
const validateLookup = validator.compile(schemas.lookup_case_law);

export const isSearchResults = (value: unknown): value is SearchResults =>
  validateSearch(value);
export const isLookupResults = (value: unknown): value is LookupResults =>
  validateLookup(value);

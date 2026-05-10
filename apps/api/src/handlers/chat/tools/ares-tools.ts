import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import { lookupByIco, searchByName } from "@stll/ares";

export const createAresTools = () => ({
  ares_lookup_company: tool({
    description:
      "Look up a Czech company or economic subject in ARES by IČO. Use this for Czech company identification, registered address, legal form, statutory bodies, court file, and registry details.",
    inputSchema: valibotSchema(
      v.strictObject({
        ico: v.pipe(
          v.string(),
          v.description("Czech company IČO, with or without leading zeros."),
        ),
      }),
    ),
    execute: async ({ ico }) => await lookupByIco(ico),
  }),
  ares_search_companies: tool({
    description:
      "Search Czech companies and economic subjects in ARES by name. Use this when the user knows a company name but not the IČO.",
    inputSchema: valibotSchema(
      v.strictObject({
        name: v.pipe(v.string(), v.description("Company name to search for.")),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(50),
            v.description("Maximum number of results."),
          ),
        ),
      }),
    ),
    execute: async ({ limit, name }) =>
      await searchByName(name, limit === undefined ? undefined : { limit }),
  }),
});

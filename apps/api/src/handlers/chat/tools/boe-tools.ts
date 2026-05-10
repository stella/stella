import { valibotSchema } from "@ai-sdk/valibot";
import {
  findRelatedLaws,
  getBormeSummary,
  getConsolidatedLaw,
  getLawStructure,
  getLawTextBlock,
  RELATION_TYPES,
  searchConsolidatedLegislation,
} from "@stll/boe";
// oxlint-disable-next-line no-restricted-imports
import { tool } from "ai";
import * as v from "valibot";

const lawIdSchema = v.pipe(
  v.string(),
  v.regex(
    /^BOE-[A-Z]-\d{4}-\d+$/,
    "BOE law id (e.g. BOE-A-1889-4763) — letter section, year, sequence",
  ),
  v.description(
    "BOE document identifier, e.g. BOE-A-1889-4763 for the Código Civil.",
  ),
);

const dateSchema = v.pipe(
  v.string(),
  v.regex(/^\d{8}$/, "Date in YYYYMMDD format"),
  v.description("Date in YYYYMMDD format (e.g. 20260510)."),
);

export const createBoeTools = () => ({
  boe_search_legislation: tool({
    description:
      "Search Spain's consolidated legislation (~50,000 norms) by free text, title, department, legal range (Ley, Real Decreto, etc.), subject matter, or publication date. Use this to discover laws by topic before fetching their full text. Returns titles + BOE identifiers (e.g. BOE-A-1889-4763) you can pass to boe_get_law.",
    inputSchema: valibotSchema(
      v.strictObject({
        text: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Free-text query searched in both title and full text.",
            ),
          ),
        ),
        title: v.optional(
          v.pipe(
            v.string(),
            v.description("Phrase-exact match restricted to the title."),
          ),
        ),
        departmentCode: v.optional(
          v.pipe(
            v.string(),
            v.description("Department code from the BOE auxiliary table."),
          ),
        ),
        legalRangeCode: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Legal range code: 1100=Ley Orgánica, 1200=Ley, 1300=Real Decreto-ley, 1400=Real Decreto Legislativo, 1510=Real Decreto, 1900=Orden, etc.",
            ),
          ),
        ),
        matterCode: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Subject-matter code from the BOE controlled vocabulary.",
            ),
          ),
        ),
        dateFrom: v.optional(
          v.pipe(
            v.string(),
            v.regex(/^\d{8}$/),
            v.description("Lower bound on publication date (YYYYMMDD)."),
          ),
        ),
        dateTo: v.optional(
          v.pipe(
            v.string(),
            v.regex(/^\d{8}$/),
            v.description("Upper bound on publication date (YYYYMMDD)."),
          ),
        ),
        offset: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(0),
            v.maxValue(10_000),
            v.description("Zero-based result offset for pagination."),
          ),
        ),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
            v.description("Maximum number of results (default 25, max 100)."),
          ),
        ),
      }),
    ),
    execute: async ({ limit, offset, ...query }) =>
      await searchConsolidatedLegislation({ ...query, limit, offset }),
  }),

  boe_get_law: tool({
    description:
      "Fetch a Spanish consolidated law by its BOE identifier. Returns metadata (date, department, status), legal analysis (relationships to other norms), and optionally the full text. Use after boe_search_legislation to obtain the actual content of a norm.",
    inputSchema: valibotSchema(
      v.strictObject({
        lawId: lawIdSchema,
        metadata: v.optional(
          v.pipe(
            v.boolean(),
            v.description("Include metadata section. Default true."),
          ),
        ),
        analysis: v.optional(
          v.pipe(
            v.boolean(),
            v.description("Include legal analysis section. Default true."),
          ),
        ),
        fullText: v.optional(
          v.pipe(
            v.boolean(),
            v.description(
              "Include the full consolidated text. Default false — can be very large.",
            ),
          ),
        ),
        eli: v.optional(
          v.pipe(
            v.boolean(),
            v.description(
              "Include ELI (European Legislation Identifier) metadata. Default false.",
            ),
          ),
        ),
      }),
    ),
    execute: async ({ lawId, ...sections }) =>
      await getConsolidatedLaw(lawId, sections),
  }),

  boe_get_law_structure: tool({
    description:
      "Fetch the table of contents (articles, dispositions, annexes) of a Spanish consolidated law. Use this to discover block IDs that boe_get_law_block can fetch individually.",
    inputSchema: valibotSchema(v.strictObject({ lawId: lawIdSchema })),
    execute: async ({ lawId }) => ({
      lawId,
      structure: await getLawStructure(lawId),
    }),
  }),

  boe_get_law_block: tool({
    description:
      "Fetch a single article or disposition (block) of a Spanish consolidated law by its block ID. Cheaper and more focused than fetching the full text. Get block IDs from boe_get_law_structure.",
    inputSchema: valibotSchema(
      v.strictObject({
        lawId: lawIdSchema,
        blockId: v.pipe(
          v.string(),
          v.description(
            "Block identifier from the law's structure (e.g. a1902 for article 1902).",
          ),
        ),
      }),
    ),
    execute: async ({ blockId, lawId }) => ({
      lawId,
      blockId,
      block: await getLawTextBlock(lawId, blockId),
    }),
  }),

  boe_find_related_laws: tool({
    description:
      "Find Spanish norms that modify, derogate, or are modified/derogated by a given law. Returns the raw analysis section so the model can pick the relations it needs.",
    inputSchema: valibotSchema(
      v.strictObject({
        lawId: lawIdSchema,
        relationType: v.optional(
          v.pipe(
            v.picklist([
              RELATION_TYPES.modifies,
              RELATION_TYPES.modifiedBy,
              RELATION_TYPES.derogates,
              RELATION_TYPES.derogatedBy,
              RELATION_TYPES.all,
            ]),
            v.description("Which relation kind to focus on. Default 'all'."),
          ),
        ),
      }),
    ),
    execute: async ({ lawId, relationType }) =>
      await findRelatedLaws(lawId, relationType ?? RELATION_TYPES.all),
  }),

  borme_get_summary: tool({
    description:
      "Fetch the daily BORME (Boletín Oficial del Registro Mercantil) — Spain's commercial registry gazette. Use this for due diligence: company formations, director changes, capital increases, dissolutions published on a given day. The Spanish business registry has no real-time API, so this is the canonical source for recent corporate events.",
    inputSchema: valibotSchema(
      v.strictObject({
        date: dateSchema,
        provinceCode: v.optional(
          v.pipe(
            v.string(),
            v.description(
              "Optional province code filter (e.g. M for Madrid, B for Barcelona).",
            ),
          ),
        ),
      }),
    ),
    execute: async ({ date, provinceCode }) => ({
      date,
      summary: await getBormeSummary(date, { provinceCode }),
    }),
  }),
});

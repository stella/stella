import { status, t } from "elysia";

import {
  AresAPIError,
  AresRequestError,
  AresTooBroadError,
  AresValidationError,
  lookupByIco,
  searchByName,
} from "@stella/ares";

import { createRootHandler } from "@/api/lib/api-handlers";

const aresQuerySchema = t.Object({
  ico: t.Optional(t.String({ minLength: 1, maxLength: 11 })),
  name: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
});

const aresLookup = createRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: aresQuerySchema,
  },
  async ({ query }) => {
    const { ico, name } = query;

    if (!ico && !name) {
      return status(400, {
        message: "Either 'ico' or 'name' query parameter is required",
      });
    }

    if (ico && name) {
      return status(400, {
        message: "Provide either 'ico' or 'name', not both",
      });
    }

    try {
      if (ico) {
        const company = await lookupByIco(ico);
        return { type: "lookup" as const, company };
      }

      // SAFETY: the guard clauses above ensure name is defined here
      const results = await searchByName(name ?? "");
      return { type: "search" as const, results };
    } catch (error: unknown) {
      if (error instanceof AresValidationError) {
        return status(400, { message: error.message });
      }
      if (error instanceof AresTooBroadError) {
        return status(400, {
          message: "Search too broad. Please refine your query.",
        });
      }
      if (error instanceof AresAPIError) {
        return status(502, {
          message: `ARES API error: ${error.message}`,
        });
      }
      if (error instanceof AresRequestError) {
        return status(502, {
          message: `ARES request failed: ${error.message}`,
        });
      }
      throw error;
    }
  },
);

export default aresLookup;

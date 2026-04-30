import {
  AresAPIError,
  AresRequestError,
  AresTooBroadError,
  AresValidationError,
  lookupByIco,
  searchByName,
} from "@stll/ares";
import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const aresQuerySchema = t.Object({
  ico: t.Optional(t.String({ minLength: 1, maxLength: 11 })),
  name: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
});

const aresLookup = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: aresQuerySchema,
  },
  async function* ({ query }) {
    const { ico, name } = query;

    if (!ico && !name) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Either 'ico' or 'name' query parameter is required",
        }),
      );
    }

    if (ico && name) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Provide either 'ico' or 'name', not both",
        }),
      );
    }

    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          if (ico) {
            const company = await lookupByIco(ico);
            return { type: "lookup" as const, company };
          }

          const results = await searchByName(name ?? "");
          return { type: "search" as const, results };
        },
        catch: (error): HandlerError => {
          if (error instanceof AresValidationError) {
            return new HandlerError({ status: 400, message: error.message });
          }
          if (error instanceof AresTooBroadError) {
            return new HandlerError({
              status: 400,
              message: "Search too broad. Please refine your query.",
            });
          }
          if (error instanceof AresAPIError) {
            return new HandlerError({
              status: 502,
              message: `ARES API error: ${error.message}`,
            });
          }
          if (error instanceof AresRequestError) {
            return new HandlerError({
              status: 502,
              message: `ARES request failed: ${error.message}`,
            });
          }
          return new HandlerError({
            status: 500,
            message: "ARES lookup failed",
            cause: error,
          });
        },
      }),
    );

    return Result.ok(result);
  },
);

export default aresLookup;

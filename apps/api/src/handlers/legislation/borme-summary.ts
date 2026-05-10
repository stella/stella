import { getBormeSummary } from "@stll/boe";
import { Result } from "better-result";
import { t } from "elysia";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const paramsSchema = t.Object({
  date: t.String({ pattern: "^\\d{8}$" }),
});

const querySchema = t.Object({
  provinceCode: t.Optional(t.String({ minLength: 1, maxLength: 8 })),
});

const bormeSummary = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    params: paramsSchema,
    query: querySchema,
  },
  async function* ({ params: { date }, query }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => await getBormeSummary(date, query),
        catch: mapBoeError,
      }),
    );

    return Result.ok({ date, summary: result });
  },
);

export default bormeSummary;

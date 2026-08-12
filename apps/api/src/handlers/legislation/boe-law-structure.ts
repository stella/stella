import { Result } from "better-result";
import { t } from "elysia";

import { getLawStructure } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const paramsSchema = t.Object({
  lawId: t.String({ pattern: "^BOE-[A-Z]-\\d{4}-\\d+$" }),
});

const boeLawStructure = createSafeRootHandler(
  {
    description:
      "Read the block outline of one consolidated Spanish BOE law: its " +
      "parts, articles, and provisions with the block ids that address them. " +
      "Use legislation.boe-text-block to fetch the text of a single block.",
    permissions: { workspace: ["read"] },
    mcp: { type: "covered", by: "search_legislation" },
    access: "read",
    params: paramsSchema,
  },
  async function* ({ params: { lawId } }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => await getLawStructure(lawId),
        catch: mapBoeError,
      }),
    );

    return Result.ok({ lawId, structure: result });
  },
);

export default boeLawStructure;

import { Result } from "better-result";
import { t } from "elysia";

import { getLawTextBlock } from "@stll/boe";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const paramsSchema = t.Object({
  lawId: t.String({ pattern: "^BOE-[A-Z]-\\d{4}-\\d+$" }),
  blockId: t.String({ minLength: 1, maxLength: 128 }),
});

const boeTextBlock = createSafeRootHandler(
  {
    description:
      "Read the text of one block of a consolidated Spanish BOE law, " +
      "addressed by the law identifier and a block id taken from " +
      "legislation.boe-law-structure.",
    permissions: { workspace: ["read"] },
    mcp: { type: "covered", by: "search_legislation" },
    access: "read",
    params: paramsSchema,
  },
  async function* ({ params: { lawId, blockId } }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => await getLawTextBlock(lawId, blockId),
        catch: mapBoeError,
      }),
    );

    return Result.ok({ lawId, blockId, block: result });
  },
);

export default boeTextBlock;

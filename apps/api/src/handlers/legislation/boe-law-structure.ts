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
    permissions: { workspace: ["read"] },
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

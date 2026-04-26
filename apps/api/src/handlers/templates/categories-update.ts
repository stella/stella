import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  updateTemplateCategoryBodySchema,
  updateTemplateCategoryHandler,
} from "./categories";

const updateTemplateCategoryParamsSchema = t.Object({
  categoryId: tSafeId("templateCategory"),
});

const config = {
  permissions: { template: ["update"] },
  params: updateTemplateCategoryParamsSchema,
  body: updateTemplateCategoryBodySchema,
} satisfies HandlerConfig;

const updateTemplateCategory = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await updateTemplateCategoryHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            categoryId: params.categoryId,
            body,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default updateTemplateCategory;

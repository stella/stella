import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  TEMPLATE_VERSIONS_PAGE_SIZE_DEFAULT,
  listTemplateVersionsHandler,
} from "./versions";

const listTemplateVersionsParamsSchema = t.Object({
  templateId: tSafeId("template"),
});

const listTemplateVersionsQuerySchema = t.Object({
  cursor: t.Optional(t.String()),
  limit: t.Optional(
    t.Integer({ minimum: 1, maximum: LIMITS.templateVersionsPerTemplate }),
  ),
});

const config = {
  permissions: { workspace: ["read"] },
  params: listTemplateVersionsParamsSchema,
  query: listTemplateVersionsQuerySchema,
} satisfies HandlerConfig;

const listTemplateVersions = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params, query }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await listTemplateVersionsHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            cursor: query.cursor,
            limit: query.limit ?? TEMPLATE_VERSIONS_PAGE_SIZE_DEFAULT,
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

export default listTemplateVersions;

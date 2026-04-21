import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { getTemplateVersionHandler } from "./versions";

const getTemplateVersionParamsSchema = t.Object({
  templateId: tUuid,
  versionId: tUuid,
});

const config = {
  permissions: { workspace: ["read"] },
  params: getTemplateVersionParamsSchema,
} satisfies HandlerConfig;

const getTemplateVersion = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, params }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getTemplateVersionHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            templateId: params.templateId,
            versionId: params.versionId,
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

export default getTemplateVersion;

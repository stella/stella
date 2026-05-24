import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  createTemplateCategoryBodySchema,
  createTemplateCategoryHandler,
} from "./categories";

const config = {
  permissions: { template: ["create"] },
  body: createTemplateCategoryBodySchema,
} satisfies HandlerConfig;

const createTemplateCategory = createSafeRootHandler(
  config,
  async function* ({ scopedDb, session, body, recordAuditEvent }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createTemplateCategoryHandler({
            scopedDb,
            organizationId: session.activeOrganizationId,
            body,
            recordAuditEvent,
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

export default createTemplateCategory;

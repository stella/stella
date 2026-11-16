import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

import {
  listTemplateVersionsHandler,
  TEMPLATE_VERSIONS_PAGE_SIZE_DEFAULT,
} from "../versions";

const listTemplateVersionsParamsSchema = v.object({
  templateId: resourceIdSchema("template"),
});

const listTemplateVersionsQuerySchema = v.object({
  cursor: v.optional(paginationCursorSchema()),
  limit: v.optional(
    numberFromString(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.templateVersionsPerTemplate),
      ),
    ),
  ),
});

const config = {
  contract: "patch",
  description:
    "List one template's versions, newest first, with cursor pagination. " +
    "Each entry carries its version number, field count, creation time, and " +
    "the author's name and image, which are blank for a version saved by " +
    "someone who has left the organization.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
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

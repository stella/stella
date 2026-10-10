import { KindGuard, Type } from "@sinclair/typebox";

import type { Transaction } from "@/api/db/root";
import { isScopedFeatureEnabled } from "@/api/db/scoped-feature-access";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import type { AdvertisedSchemas } from "@/api/mcp/advertised-schema";
import type { McpToolInputSchema } from "@/api/mcp/tool-types";

const LIST_PLACEMENT_FIELDS = [
  "listId",
  "listSectionId",
  "listPosition",
  "listDescription",
] as const;

const taskInputUsesLegalLists = (body: unknown): boolean =>
  isRecord(body) &&
  ((body["listItemType"] !== undefined && body["listItemType"] !== "task") ||
    LIST_PLACEMENT_FIELDS.some((field) => body[field] !== undefined));

const projectTaskListInputSchemas = (
  schemas: AdvertisedSchemas,
): AdvertisedSchemas => {
  const body = schemas.body;
  if (body === undefined || !KindGuard.IsObject(body)) {
    return schemas;
  }
  const excluded = new Set<string>(LIST_PLACEMENT_FIELDS);
  const properties = Object.fromEntries(
    Object.entries(body.properties).filter(([name]) => !excluded.has(name)),
  );
  if (properties["listItemType"] !== undefined) {
    properties["listItemType"] = KindGuard.IsOptional(
      properties["listItemType"],
    )
      ? Type.Optional(Type.Literal("task"))
      : Type.Literal("task");
  }
  return { ...schemas, body: { ...body, properties } };
};

export const LEGAL_LIST_TASK_FEATURE_ACCESS = {
  featureId: LEGAL_LISTS_FEATURE_ID,
  type: "conditional",
  decision: "when-used",
  usesFeature: ({ body }) => taskInputUsesLegalLists(body),
  projectInputSchema: projectTaskListInputSchemas,
} as const satisfies FeatureAccessRequirement;

/** REST and native task tools share this admission before resource operations. */
export const rejectUnavailableTaskListInput = async (
  tx: Pick<Transaction, "execute">,
  body: unknown,
): Promise<HandlerError | null> => {
  if (
    !taskInputUsesLegalLists(body) ||
    (await isScopedFeatureEnabled(tx, LEGAL_LISTS_FEATURE_ID))
  ) {
    return null;
  }
  return new HandlerError({ status: 404, message: "Not found" });
};

export const projectNativeTaskListInput = (
  schema: McpToolInputSchema,
): McpToolInputSchema => {
  const properties = { ...schema.properties };
  delete properties["list_id"];
  delete properties["list_section_id"];
  delete properties["list_description"];
  if (properties["item_type"] !== undefined) {
    properties["item_type"] = { type: "string", enum: ["task"] };
  }
  return { ...schema, properties };
};

export const nativeTaskInputUsesLegalLists = (args: unknown): boolean =>
  isRecord(args) &&
  ((args["item_type"] !== undefined &&
    args["item_type"] !== null &&
    args["item_type"] !== "task") ||
    ["list_id", "list_section_id", "list_description"].some(
      (field) => args[field] !== undefined && args[field] !== null,
    ));

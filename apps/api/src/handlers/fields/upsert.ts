import * as v from "valibot";

import { fieldRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  FIELD_VALUE_WRITE_PERMISSIONS,
  upsertFieldContentSchema,
  writeFieldValue,
} from "@/api/lib/fields/write-field";

const config = {
  contract: "replace",
  precondition: {
    type: "deferred",
    baselineId: "apps/api/src/handlers/fields/upsert.ts",
  },
  description:
    "Set a document's value for a property (a cell in the matter's table). " +
    "Pass the document entityId, the propertyId (from list_properties), and " +
    "a content object whose 'type' matches the property's value type: text " +
    "(value: string), single-select (value: string or null), multi-select " +
    "(value: array of strings), date (value: ISO YYYY-MM-DD or null), or int " +
    "(value: integer, optional currency: 3-letter ISO code). An empty value " +
    "clears the cell.",
  permissions: FIELD_VALUE_WRITE_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: fieldRealtimeUpdates,
  mcp: { type: "tool", name: "set_field_value" },
  body: v.object({
    propertyId: resourceIdSchema("property", {
      description: "Property ID, as returned by list_properties",
    }),
    entityId: resourceIdSchema("entity", {
      description: "Document entity ID whose cell to set",
    }),
    content: upsertFieldContentSchema,
  }),
} satisfies WorkspaceHandlerConfig;

const upsertField = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body,
    user,
    memberRole,
    recordAuditEvent,
  }) {
    return yield* writeFieldValue({
      safeDb,
      authority: memberRole,
      workspaceId,
      userId: user.id,
      recordAuditEvent,
      entityId: body.entityId,
      propertyId: body.propertyId,
      content: body.content,
    });
  },
);

export default upsertField;

import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { SIGNAL_INBOX_FEATURE_ACCESS } from "@/api/handlers/entity-views/rows/inbox-view";
import type { FeatureResourceContext } from "@/api/lib/auth/feature-access/requirements";
import { advertisedSchemas } from "@/api/mcp/advertised-schema";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

describe("conditional Inbox signal access", () => {
  for (const inboxView of [undefined, "open", "resolved", "snoozed"]) {
    test(`only Inbox windows require signal access: ${String(inboxView)}`, () => {
      const context = createTestHandlerContext<FeatureResourceContext>({
        audit: NO_AUDIT,
        safeDb: NO_DB,
        scopedDb: NO_DB,
        body: { inboxView },
        organizationId: mintAuthProviderId<"organization">(),
        userId: mintAuthProviderId<"user">(),
      });
      expect(SIGNAL_INBOX_FEATURE_ACCESS.usesFeature(context)).toBe(
        inboxView !== undefined,
      );
    });
  }
  test("ungranted discovery omits Inbox input while retaining ordinary windows", () => {
    const schemas = advertisedSchemas({
      body: v.object({
        inboxView: v.optional(v.string()),
        limit: v.optional(v.number()),
        scope: v.object({ type: v.literal("organization") }),
      }),
    });
    const projected = SIGNAL_INBOX_FEATURE_ACCESS.projectInputSchema(schemas);
    const properties = schemas.body?.properties;
    expect(projected.body?.properties).toEqual(
      Object.fromEntries(
        Object.entries(properties ?? {}).filter(
          ([property]) => property !== "inboxView",
        ),
      ),
    );
    expect(properties).toHaveProperty("inboxView");
  });
});

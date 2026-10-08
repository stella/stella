import { describe, expect, test } from "bun:test";
import { t } from "elysia";

import { SIGNAL_INBOX_FEATURE_ACCESS } from "@/api/handlers/entity-views/rows/inbox-view";
import type { FeatureResourceContext } from "@/api/lib/auth/feature-access/requirements";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

describe("conditional Inbox signal access", () => {
  for (const inboxView of [undefined, "open", "resolved", "snoozed"]) {
    test(`only Inbox windows require signal access: ${String(inboxView)}`, () => {
      const context = createTestHandlerContext<FeatureResourceContext>({
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
    const schemas = {
      body: t.Object({
        inboxView: t.Optional(t.String()),
        limit: t.Optional(t.Number()),
        scope: t.Object({ type: t.Literal("organization") }),
      }),
      params: undefined,
      query: undefined,
    };
    const projected = SIGNAL_INBOX_FEATURE_ACCESS.projectInputSchema(schemas);
    expect(projected.body?.properties).toEqual({
      limit: schemas.body.properties.limit,
      scope: schemas.body.properties.scope,
    });
    expect(schemas.body.properties).toHaveProperty("inboxView");
  });
});

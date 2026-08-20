import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { withDescription } from "@/api/lib/custom-schema";

const updateTemplatePackVisibilityBodySchema = t.Object({
  hidden: withDescription(
    t.Boolean(),
    "true hides the bundled pack catalogue from the organization's template library; installed templates stay",
  ),
});

const config = {
  description:
    "Hide or show the bundled template-pack catalogue for the organization. " +
    "Pass hidden true to stop offering packs in the template library; " +
    "templates already installed are unaffected. Owners and admins only.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: updateTemplatePackVisibilityBodySchema,
} satisfies HandlerConfig;

const updateTemplatePackVisibility = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    yield* Result.await(
      safeDb(async (tx) => {
        // Ensure a row exists, then lock it so the audit diff reads the
        // committed predecessor under concurrent toggles.
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId,
          })
          .onConflictDoNothing({ target: organizationSettings.organizationId });
        const [existing] = await tx
          .select({ hidden: organizationSettings.templatePacksHidden })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1)
          .for("update");
        const previous = existing?.hidden ?? false;
        if (previous === body.hidden) {
          return;
        }
        await tx
          .update(organizationSettings)
          .set({ templatePacksHidden: body.hidden, updatedAt: new Date() })
          .where(eq(organizationSettings.organizationId, organizationId));
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: organizationId,
          changes: {
            templatePacksHidden: { old: previous, new: body.hidden },
          },
        });
      }),
    );

    return Result.ok({ hidden: body.hidden });
  },
);

export default updateTemplatePackVisibility;

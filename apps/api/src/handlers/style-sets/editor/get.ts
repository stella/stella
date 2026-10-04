import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStyleSetEditorPreset } from "@/api/lib/style-set-editor";
import { readStyleSetPackage } from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Returns parsed style editor configuration rather than stored-file bytes.",
  },
  description:
    "Read one organization style set as editor settings: its name, " +
    "updatedAt, and the style settings parsed out of the stored DOCX " +
    "package. Pass that updatedAt back to style-sets.from-editor.update as " +
    "expectedUpdatedAt so a concurrent edit is not silently overwritten.",
  permissions: { styleSet: ["use"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    const stored = yield* Result.await(
      readStyleSetPackage({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: params.styleSetId,
      }),
    );
    const editor = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await readStyleSetEditorPreset(stored.file, stored.name),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not prepare the style set editor.",
            cause,
          }),
      }),
    );

    return Result.ok({
      name: stored.name,
      updatedAt: stored.updatedAt,
      settings: editor.settings,
    });
  },
);

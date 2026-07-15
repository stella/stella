import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStyleSetEditorPreset } from "@/api/lib/style-set-editor";
import { readStyleSetPackage } from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const config = {
  permissions: { styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
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
          await readStyleSetEditorPreset(stored.buffer, stored.name),
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

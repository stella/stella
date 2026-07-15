import { Result } from "better-result";
import { t } from "elysia";

import { replaceStoredStyleSet } from "@/api/handlers/style-sets/storage";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createStyleSetEditorBuffer,
  readStyleSetEditorPreset,
} from "@/api/lib/style-set-editor";
import { updateStyleSetFromEditorSchema } from "@/api/lib/style-set-editor-contract";
import {
  normalizeStyleSetName,
  readStyleSetPackage,
} from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const config = {
  permissions: { styleSet: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: paramsSchema,
  body: updateStyleSetFromEditorSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const name = yield* normalizeStyleSetName(body.name);
    const stored = yield* Result.await(
      readStyleSetPackage({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: params.styleSetId,
      }),
    );
    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const source = await readStyleSetEditorPreset(
            stored.buffer,
            stored.name,
          );
          return await createStyleSetEditorBuffer(
            source.preset,
            name,
            body.settings,
          );
        },
        catch: (cause) =>
          new HandlerError({
            status: 400,
            message: "Could not update the style set package.",
            cause,
          }),
      }),
    );
    const row = yield* Result.await(
      replaceStoredStyleSet({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: params.styleSetId,
        name,
        buffer,
        expectedUpdatedAt: body.expectedUpdatedAt,
        recordAuditEvent,
      }),
    );

    return Result.ok({ id: row.id, name: row.name, updatedAt: row.updatedAt });
  },
);

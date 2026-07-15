import { Result } from "better-result";

import { createStoredStyleSet } from "@/api/handlers/style-sets/storage";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createStellaStyleEditorPreset,
  createStyleSetEditorBuffer,
} from "@/api/lib/style-set-editor";
import { createStyleSetFromEditorSchema } from "@/api/lib/style-set-editor-contract";
import { normalizeStyleSetName } from "@/api/lib/style-sets";

const config = {
  permissions: { styleSet: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: createStyleSetFromEditorSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const name = yield* normalizeStyleSetName(body.name);
    const source = createStellaStyleEditorPreset();
    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createStyleSetEditorBuffer(source.preset, name, body.settings),
        catch: (cause) =>
          HandlerError.is(cause)
            ? cause
            : new HandlerError({
                status: 400,
                message: "Could not build the style set.",
                cause,
              }),
      }),
    );
    const row = yield* Result.await(
      createStoredStyleSet({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        name,
        buffer,
        recordAuditEvent,
      }),
    );

    return Result.ok({ id: row.id, name: row.name, updatedAt: row.updatedAt });
  },
);

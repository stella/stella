import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStyleCatalogue } from "@/api/lib/house-style/convert";
import { isStyleGuideCurrent } from "@/api/lib/house-style/guide";
import { readStyleSetPackage } from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });

const config = {
  description:
    "Read the paragraph styles one style set actually uses, each with the " +
    "formatting it resolves to, the number its level prints, how often the " +
    "stored package uses it and up to three examples. This is what a style " +
    "guide is written against: pass its style ids to " +
    "style-sets.style-guide.update, which refuses an id this catalogue does " +
    "not carry.",
  permissions: { styleSet: ["use"] },
  access: "read",
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
    const read = await readStyleCatalogue({ bytes: stored.buffer });
    if (Result.isError(read)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: read.error.message,
          cause: read.error,
        }),
      );
    }
    const catalogue = read.value;

    return Result.ok({
      name: stored.name,
      updatedAt: stored.updatedAt,
      catalogue,
      styleGuide: stored.styleGuide,
      /** False where the guide was written against an older package. */
      styleGuideCurrent:
        stored.styleGuide !== null &&
        isStyleGuideCurrent(stored.styleGuide, catalogue),
    });
  },
);

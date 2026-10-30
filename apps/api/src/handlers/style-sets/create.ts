import { Result } from "better-result";
import * as v from "valibot";

import { createStoredStyleSet } from "@/api/handlers/style-sets/storage";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { defaultVarcharSchema, fileSchema } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import {
  extractStyleSetFile,
  normalizeStyleSetName,
} from "@/api/lib/style-sets";

const bodySchema = v.object({
  name: defaultVarcharSchema,
  styleSource: fileSchema({ maxBytes: FILE_SIZE_LIMIT_BYTES.document }),
});

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason:
      "Stores a style package and returns its metadata rather than file bytes.",
  },
  description:
    "Create an organization style set from an uploaded DOCX, taking that " +
    "document's styles as the stored package. Any upload whose file name " +
    "ends in .docx is accepted whatever media type it declares. Use " +
    "style-sets.from-editor.create to build one from explicit settings " +
    "instead of a file.",
  permissions: { styleSet: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  transport: {
    type: "file-input",
    input: {
      field: "styleSource",
      required: true,
      // Empty because the handler enforces no media type: `validateStyleSource`
      // accepts any type whose filename ends in `.docx`, which is what a browser
      // upload of a DOCX commonly looks like. Listing DOCX_MIME_TYPE here would
      // tell `describe_capability` that everything else is rejected.
      mediaTypes: [],
    },
    alternative: {
      type: "partial",
      via: ["style-sets.from-editor.create"],
      limitation:
        "builds the style set from explicit settings in the body; styles cannot be extracted from an existing DOCX",
    },
  },
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const name = yield* normalizeStyleSetName(body.name);
    const file = yield* Result.await(
      extractStyleSetFile(body.styleSource, name),
    );

    const row = yield* Result.await(
      createStoredStyleSet({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        name,
        file,
        recordAuditEvent,
      }),
    );
    return Result.ok({ id: row.id, name: row.name, updatedAt: row.updatedAt });
  },
);

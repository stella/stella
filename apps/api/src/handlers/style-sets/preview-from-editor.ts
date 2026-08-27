import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import {
  createStellaStyleEditorPreset,
  createStyleSetEditorPreviewBuffer,
  readStyleSetEditorPreset,
} from "@/api/lib/style-set-editor";
import { styleSetPreviewFromEditorSchema } from "@/api/lib/style-set-editor-contract";
import { readStyleSetPackage } from "@/api/lib/style-sets";
import { OCTET_STREAM_MIME_TYPE } from "@/api/mime-types";

const config = {
  description:
    "Render a content-free style set configuration against bounded sample " +
    "contract text and return a DOCX for the visual style editor preview. " +
    "Saved style sets are read within the caller's organization.",
  permissions: { styleSet: ["use"] },
  access: "read",
  mcp: { type: "internal", reason: "native_tool_ui" },
  transport: {
    type: "file-response",
    response: { mediaTypes: [OCTET_STREAM_MIME_TYPE] },
    alternative: {
      type: "none",
      reason: "the response is a transient Folio rendering input for the UI",
    },
  },
  body: styleSetPreviewFromEditorSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session }) {
    let source;
    let name;
    if (body.type === "stella") {
      const editor = createStellaStyleEditorPreset();
      source = editor.preset;
      name = editor.preset.name;
    } else {
      const stored = yield* Result.await(
        readStyleSetPackage({
          safeDb,
          organizationId: session.activeOrganizationId,
          styleSetId: body.styleSetId,
        }),
      );
      const editor = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await readStyleSetEditorPreset(stored.buffer, stored.name),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Could not prepare the style set preview.",
              cause,
            }),
        }),
      );
      source = editor.preset;
      name = stored.name;
    }

    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await createStyleSetEditorPreviewBuffer({
            source,
            name,
            settings: body.settings,
            content: body.content,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not render the style set preview.",
            cause,
          }),
      }),
    );

    return Result.ok(
      secureDocumentResponse({
        body: buffer,
        contentType: OCTET_STREAM_MIME_TYPE,
        disposition: "inline",
        fileName: sanitizeFilename("style-set-preview.docx"),
        contentLength: buffer.byteLength,
      }),
    );
  },
);

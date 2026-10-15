import { Result } from "better-result";

import { GENERATED_VISUAL_LIMITS } from "@stll/api-contract/generated-visual";

import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import { uploadUserFile } from "@/api/handlers/chat/upload-files";
import { captureError } from "@/api/lib/analytics/capture";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

import { VISUAL_INNER_POLICY } from "./document";
import runtime from "./generated/runtime.js.txt" with { type: "text" };
import type { PreparedGeneratedVisual } from "./prepare";
import { composeVisualDocument } from "./srcdoc";

type CreateVisualStoreOptions = Omit<
  Parameters<typeof uploadUserFile>[0],
  "file" | "dependencies"
>;

export const createVisualStore =
  (context: CreateVisualStoreOptions) =>
  async (visual: PreparedGeneratedVisual) => {
    const document = composeVisualDocument({
      html: visual.html,
      data: visual.data,
      // Only the size matters here; any id has the length of a real one.
      renderId: Bun.randomUUIDv7(),
      runtime,
      policy: VISUAL_INNER_POLICY,
    });
    if (
      new TextEncoder().encode(document).byteLength >
      GENERATED_VISUAL_LIMITS.documentBytes
    ) {
      return Result.err(
        new ChatToolError({
          kind: "invalid-input",
          message:
            "Reduce the page or its data so the rendered document fits within 2 MB.",
        }),
      );
    }
    const { title, html, data, links } = visual;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ title, html, data, links }),
    );
    const stored = await uploadUserFile({
      ...context,
      file: {
        bytes,
        fileName: "generated-view.txt",
        mimeType: TEXT_PLAIN_MIME_TYPE,
      },
    });
    if (stored.isErr()) {
      captureError(stored.error, { source: "show_visual" });
      return Result.err(
        new ChatToolError({
          kind: "server-defect",
          message:
            "The generated view could not be stored. Try again or continue with a text answer.",
          cause: stored.error,
        }),
      );
    }
    return Result.ok({ fileId: stored.value.id, document });
  };

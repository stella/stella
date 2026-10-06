import type { UIResourcePart } from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import {
  GENERATED_VISUAL_MIME_TYPE,
  GENERATED_VISUAL_URI_PREFIX,
  generatedVisualPartSchema,
} from "@stll/api-contract/generated-visual";
import { VISUAL_PREVIEW_TOOL_NAME } from "@stll/api-contract/visual-preview";

import type { SafeId } from "@/api/lib/branded-types";

type IssueVisualResourceOptions = {
  fileId: SafeId<"userFile">;
  title: string;
  toolCallId: string;
};

// This ledger belongs to one server turn. Wire fields never establish origin:
// only a resource issued by that turn's native tool may cross persistence.
export const createVisualResourceOrigin = () => {
  const issued = new Map<string, string>();
  return {
    issue: ({ fileId, title, toolCallId }: IssueVisualResourceOptions) => {
      const candidate = {
        type: "ui-resource",
        resource: {
          uri: `${GENERATED_VISUAL_URI_PREFIX}${fileId}`,
          mimeType: GENERATED_VISUAL_MIME_TYPE,
          text: title,
        },
        toolCallId,
        toolName: VISUAL_PREVIEW_TOOL_NAME,
      } as const satisfies UIResourcePart;
      const result = v.safeParse(generatedVisualPartSchema, candidate);
      if (!result.success) {
        return panic("A native visual resource violates its contract");
      }
      const part = result.output;
      issued.set(part.resource.uri, JSON.stringify(part));
      return part;
    },
    accepts: (candidate: unknown) => {
      const result = v.safeParse(generatedVisualPartSchema, candidate);
      if (!result.success) {
        return false;
      }
      return (
        issued.get(result.output.resource.uri) === JSON.stringify(result.output)
      );
    },
  };
};

export type VisualResourceOrigin = ReturnType<
  typeof createVisualResourceOrigin
>;

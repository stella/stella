import { describe, expect, test } from "bun:test";

import { GENERATED_VISUAL_MIME_TYPE } from "@stll/api-contract/generated-visual";

import { classifyChatPartForPersistence } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";

import { createVisualResourceOrigin } from "./resource-origin";

describe("native visual resource persistence", () => {
  test("requires the issuing turn and preserves the visual MIME", () => {
    const origin = createVisualResourceOrigin();
    const part = origin.issue({
      fileId: createSafeId<"userFile">(),
      title: "Court overview",
      toolCallId: "visual-call-one",
    });
    const clone: unknown = structuredClone(part);
    expect(classifyChatPartForPersistence(clone).type).toBe("drop");
    expect(
      classifyChatPartForPersistence(clone, createVisualResourceOrigin()).type,
    ).toBe("drop");
    const stored = classifyChatPartForPersistence(clone, origin);
    expect(stored.type).toBe("persist");
    if (stored.type === "persist" && stored.part.type === "ui-resource") {
      expect(stored.part.resource.mimeType).toBe(GENERATED_VISUAL_MIME_TYPE);
      expect(stored.part.resource.text).toBe(part.resource.text);
      expect(stored.part.resource.uri).toBe(part.resource.uri);
    }
    for (const candidate of [
      { ...part, serverId: "connector-one" },
      { ...part, toolName: "connector-tool" },
      { ...part, toolCallId: "another-call" },
      { ...part, resource: { ...part.resource, text: "Another title" } },
      { ...part, resource: { ...part.resource, uri: `${part.resource.uri}x` } },
    ]) {
      expect(classifyChatPartForPersistence(candidate, origin).type).toBe(
        "drop",
      );
    }
  });
});

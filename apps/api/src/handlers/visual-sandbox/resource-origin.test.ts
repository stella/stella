import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { GENERATED_VISUAL_MIME_TYPE } from "@stll/api-contract/generated-visual";
import {
  readStellaMcpAppCall,
  STELLA_MCP_APP_LIMITS,
  STELLA_MCP_APP_MIME_TYPE,
} from "@stll/api-contract/stella-mcp-app";

import {
  classifyChatPartForPersistence,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
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

describe("stella app resource persistence", () => {
  const call = {
    input: { query: "unfair dismissal" },
    result: { structuredContent: { results: [{ id: "decision-one" }] } },
  };

  test("persists only the part the server minted for the call it ran", () => {
    const origin = createVisualResourceOrigin();
    const minted = origin.issueMcpApp({
      call,
      toolCallId: "app-call-one",
      toolName: "search_case_law",
    });
    if (Result.isError(minted)) {
      return panic(minted.error);
    }
    const part = minted.value;
    expect(part.resource.mimeType).toBe(STELLA_MCP_APP_MIME_TYPE);
    expect(readStellaMcpAppCall(part)).toEqual(call);

    const clone: unknown = structuredClone(part);
    expect(classifyChatPartForPersistence(clone).type).toBe("drop");
    expect(
      classifyChatPartForPersistence(clone, createVisualResourceOrigin()).type,
    ).toBe("drop");
    expect(classifyChatPartForPersistence(clone, origin).type).toBe("persist");

    const forgedResult = JSON.stringify({
      input: call.input,
      result: { structuredContent: { results: [{ id: "decision-two" }] } },
    });
    for (const candidate of [
      { ...part, toolCallId: "another-call" },
      { ...part, toolName: "read_case_law_citations" },
      { ...part, resource: { ...part.resource, text: forgedResult } },
      {
        ...part,
        resource: { ...part.resource, uri: "ui://stella/decision-reader" },
      },
    ]) {
      expect(classifyChatPartForPersistence(candidate, origin).type).toBe(
        "drop",
      );
    }
  });

  test("keeps a stored part when the turn is continued", () => {
    const minted = createVisualResourceOrigin().issueMcpApp({
      call,
      toolCallId: "app-call-stored",
      toolName: "read_provision_history",
    });
    if (Result.isError(minted)) {
      return panic(minted.error);
    }
    const continued = createVisualResourceOrigin({
      persistedParts: [minted.value],
    });
    expect(
      classifyChatPartForPersistence(structuredClone(minted.value), continued)
        .type,
    ).toBe("persist");
  });

  test("mints nothing for a tool no chat app presents, or a call too large to carry", () => {
    const origin = createVisualResourceOrigin();
    for (const toolName of ["read_document", "open_document_version_upload"]) {
      expect(
        Result.isError(
          origin.issueMcpApp({ call, toolCallId: "app-call-none", toolName }),
        ),
      ).toBe(true);
    }
    const large = origin.issueMcpApp({
      call: {
        input: {},
        result: {
          structuredContent: {
            text: "x".repeat(STELLA_MCP_APP_LIMITS.payloadChars),
          },
        },
      },
      toolCallId: "app-call-large",
      toolName: "search_case_law",
    });
    expect(Result.isError(large)).toBe(true);
  });

  test("reloads the stored part exactly as it was shown", () => {
    const origin = createVisualResourceOrigin();
    const minted = origin.issueMcpApp({
      call,
      toolCallId: "app-call-reload",
      toolName: "search_case_law",
    });
    if (Result.isError(minted)) {
      return panic(minted.error);
    }
    const decision = classifyChatPartForPersistence(
      structuredClone(minted.value),
      origin,
    );
    if (decision.type !== "persist") {
      return panic("The minted part was not persisted");
    }
    const stored = toPersistedChatMessageContentV3({ data: [decision.part] });
    const reloaded = normalizePersistedChatMessageContent(
      structuredClone(stored),
    ).parts;
    expect(reloaded).toEqual([minted.value]);
  });
});

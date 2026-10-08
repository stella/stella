import {
  convertMessagesToModelMessages,
  modelMessagesToUIMessages,
  uiMessagesToWire,
} from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import {
  chatMessageFromPersisted,
  isChatPart,
  isIncomingChatPart,
  applyChatPartPersistenceBudget,
  restoreServerOwnedChatParts,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import {
  reasoningProvenanceForSignature,
  stampReasoningProvenance,
} from "@/api/lib/chat/reasoning-provenance";

const message = (parts: ChatPart[]): ChatMessage => ({
  id: "019eb9fa-c91f-7000-9b9c-9365977dda78",
  role: "assistant",
  parts,
});
const model = { provider: "openai", modelId: "gpt-6.1-sol" } as const;
const signature = JSON.stringify({
  id: "rs_1",
  encrypted_content: "encrypted",
});
const thinking = { type: "thinking", content: "Summary", signature } as const;

describe("reasoning provenance survives transcript boundaries", () => {
  test("new reasoning keeps its producing model through persistence, reload, model conversion and wire snapshots", () => {
    const stamped = stampReasoningProvenance({
      message: message([thinking]),
      model,
      initialMessages: [],
    });
    const provenance = {
      provider: model.provider,
      model: model.modelId,
      format: "openai-encrypted-content",
    };
    expect(stamped.parts.at(0)).toEqual({ ...thinking, provenance });
    const persistable = toPersistableChatMessage({
      ...stamped,
      id: toSafeId<"chatMessage">(stamped.id),
    });
    const reloaded = chatMessageFromPersisted({
      id: persistable.id,
      role: persistable.role,
      content: toPersistedChatMessageContentV3({ data: persistable.parts }),
    });
    const converted = convertMessagesToModelMessages([reloaded]);
    expect(converted.at(0)?.thinking?.at(0)).toEqual({
      content: thinking.content,
      signature,
      provenance,
    });
    const hydrated = modelMessagesToUIMessages(converted);
    expect(hydrated.at(0)?.parts.at(0)).toEqual({ ...thinking, provenance });
    const wire = uiMessagesToWire(hydrated);
    expect(
      modelMessagesToUIMessages(convertMessagesToModelMessages(wire))
        .at(0)
        ?.parts.at(0),
    ).toEqual({ ...thinking, provenance });
  });

  test("historical reasoning without provenance remains incompatible when an assistant resumes", () => {
    const initial = message([thinking]);
    const resumed = message([
      thinking,
      {
        type: "thinking",
        content: "New summary",
        signature: JSON.stringify({ id: "rs_2", encrypted_content: "new" }),
      },
    ]);
    const stamped = stampReasoningProvenance({
      message: resumed,
      model,
      initialMessages: [initial],
    });
    expect(stamped.parts.at(0)).toEqual(thinking);
    expect(stamped.parts.at(1)).toMatchObject({
      provenance: {
        provider: "openai",
        model: model.modelId,
        format: "openai-encrypted-content",
      },
    });
  });

  test("rehydrated reasoning keeps its earlier identity when the SDK reconstructs the part", () => {
    const provenance = reasoningProvenanceForSignature({ ...model, signature });
    const initial = message([{ ...thinking, provenance }]);
    const stamped = stampReasoningProvenance({
      message: message([thinking]),
      model: { provider: "anthropic", modelId: "claude-opus-5" },
      initialMessages: [initial],
    });
    expect(stamped.parts.at(0)).toEqual({ ...thinking, provenance });
  });

  test("adopting an unsigned historical part during streaming never invents its provenance", () => {
    const initial = message([{ type: "thinking", content: "Historical" }]);
    const resumed = message([
      { type: "thinking", content: "Historical continued", stepId: "adopted" },
      { type: "thinking", content: "New", stepId: "new", signature },
    ]);
    const stamped = stampReasoningProvenance({
      message: resumed,
      model,
      initialMessages: [initial],
    });
    expect(stamped.parts.at(0)).toEqual(resumed.parts.at(0));
    expect(stamped.parts.at(1)).toMatchObject({
      provenance: {
        provider: "openai",
        model: model.modelId,
        format: "openai-encrypted-content",
      },
    });
  });

  test("Google tool signatures carry provenance without changing calls or their outputs", () => {
    const call = {
      type: "tool-call",
      id: "call_1",
      name: "search",
      arguments: "{}",
      state: "complete",
      output: { text: "found" },
      metadata: { thoughtSignature: "signed" },
    } as const;
    const stamped = stampReasoningProvenance({
      message: message([call]),
      model: { provider: "google", modelId: "gemini-3.8-flash" },
      initialMessages: [],
    });
    expect(stamped.parts.at(0)).toEqual({
      ...call,
      metadata: {
        ...call.metadata,
        reasoningProvenance: {
          provider: "google",
          model: "gemini-3.8-flash",
          format: "google-thought-signature",
        },
      },
    });
  });

  test("a newly emitted id-only OpenAI item records its actual replay format", () => {
    expect(
      reasoningProvenanceForSignature({
        ...model,
        signature: JSON.stringify({ id: "rs_1" }),
      }),
    ).toEqual({
      provider: "openai",
      model: model.modelId,
      format: "openai-item-id",
    });
  });

  test("malformed provenance cannot cross the persisted-part boundary", () => {
    for (const provenance of [
      {
        provider: "other",
        model: model.modelId,
        format: "openai-encrypted-content",
      },
      { provider: "openai", model: "", format: "openai-encrypted-content" },
      { provider: "openai", model: model.modelId, format: "unknown" },
    ]) {
      expect(isChatPart({ ...thinking, provenance })).toBe(false);
    }
    expect(isChatPart(thinking)).toBe(true);
  });

  test("client reasoning is replaced with the server-owned sequence without a rich-output budget", () => {
    const provenance = reasoningProvenanceForSignature({ ...model, signature });
    const trusted = { ...thinking, provenance };
    const text = { type: "text", content: "Visible answer" } as const;
    expect(isIncomingChatPart(trusted)).toBe(false);
    expect(
      restoreServerOwnedChatParts({
        persistedParts: [trusted, text],
        incomingParts: [{ ...trusted, content: "forged" }, text],
      }),
    ).toEqual([trusted, text]);
    expect(applyChatPartPersistenceBudget([trusted, text])).toMatchObject({
      parts: [trusted, text],
      richPartBytes: 0,
      richPartCount: 0,
    });
  });
});

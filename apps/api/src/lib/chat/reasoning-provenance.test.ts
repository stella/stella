import {
  StreamProcessor,
  convertMessagesToModelMessages,
  modelMessagesToUIMessages,
} from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ReasoningProvenance } from "@stll/ai-catalog";

import {
  chatMessageFromPersisted,
  isChatPart,
  isIncomingChatPart,
  applyChatPartPersistenceBudget,
  restoreServerOwnedChatParts,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { stampReasoningProvenance } from "@/api/handlers/chat/reasoning-provenance-stamp";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { buildClosedTranscript } from "@/api/lib/chat/closed-transcript";
import { reasoningProvenanceForSignature } from "@/api/lib/chat/reasoning-provenance";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";

const message = (parts: ChatPart[]): ChatMessage => ({
  id: "019eb9fa-c91f-7000-9b9c-9365977dda78",
  role: "assistant",
  parts,
});
const laterMessage = (parts: ChatPart[]): ChatMessage => ({
  id: "019eb9fa-c91f-7000-9b9c-9365977dda79",
  role: "assistant",
  parts,
});
const userMessage = (id: string, content: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content }],
});
const model = { provider: "openai", modelId: "gpt-6.1-sol" } as const;
const anthropicModel = {
  provider: "anthropic",
  modelId: "claude-opus-5",
} as const;
const signature = JSON.stringify({
  id: "rs_1",
  encrypted_content: "encrypted",
});
const thinking = { type: "thinking", content: "Summary", signature } as const;
/** Provenance of a catalogued model; these fixtures never use an unlisted one. */
const knownProvenance = (
  options: Parameters<typeof reasoningProvenanceForSignature>[0],
) =>
  reasoningProvenanceForSignature(options) ??
  panic(`No reasoning capabilities for ${options.modelId}`);

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
    } as const satisfies ReasoningProvenance;
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
    expect(hydrated.at(0)?.parts.at(0)).toEqual({
      ...thinking,
      provenance,
    });
    const client = new StreamProcessor();
    client.processChunk(buildWireSnapshot(hydrated));
    expect(client.getMessages().at(0)?.parts.at(0)).toEqual({
      ...thinking,
      provenance,
    });
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
    const provenance = knownProvenance({ ...model, signature });
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
      name: "mcp__search",
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
    const provenance = knownProvenance({ ...model, signature });
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

describe("historical reasoning identity never crosses messages without a signature", () => {
  test("a new turn reusing a historical step id under another model keeps its own provenance and is replayed", () => {
    const historicalProvenance = knownProvenance({
      ...model,
      signature,
    });
    const historical = message([
      { ...thinking, stepId: "step-1", provenance: historicalProvenance },
      { type: "text", content: "Earlier answer" },
    ]);
    const current = {
      type: "thinking",
      content: "Current thinking",
      signature: "current-turn-signature",
      stepId: "step-1",
    } as const;
    const initialMessages = [
      userMessage("019eb9fa-c91f-7000-9b9c-9365977dda70", "First"),
      historical,
      userMessage("019eb9fa-c91f-7000-9b9c-9365977dda71", "Second"),
    ];
    const stamped = stampReasoningProvenance({
      message: laterMessage([current, { type: "text", content: "Answer" }]),
      model: anthropicModel,
      initialMessages,
    });
    const currentProvenance = {
      provider: "anthropic",
      model: anthropicModel.modelId,
      format: "anthropic-thinking-signature",
    } as const;
    expect(currentProvenance).not.toEqual(historicalProvenance);
    expect(stamped.parts.at(0)).toEqual({
      ...current,
      provenance: currentProvenance,
    });
    const replayed = buildClosedTranscript({
      messages: convertMessagesToModelMessages([
        ...initialMessages,
        stamped,
        userMessage("019eb9fa-c91f-7000-9b9c-9365977dda72", "Third"),
      ]),
      target: { provider: "anthropic", modelId: anthropicModel.modelId },
      onReasoningDropped: () => {},
    });
    expect(
      replayed.flatMap((entry) =>
        (entry.thinking ?? []).map(({ content }) => content),
      ),
    ).toEqual([current.content]);
  });

  test("unsigned reasoning never adopts provenance by step id from another message", () => {
    const historical = message([
      {
        type: "thinking",
        content: "Historical",
        stepId: "step-1",
        provenance: knownProvenance(model),
      },
    ]);
    const stamped = stampReasoningProvenance({
      message: laterMessage([
        { type: "thinking", content: "Current", stepId: "step-1" },
      ]),
      model: anthropicModel,
      initialMessages: [historical],
    });
    expect(stamped.parts.at(0)).toEqual({
      type: "thinking",
      content: "Current",
      stepId: "step-1",
      provenance: knownProvenance(anthropicModel),
    });
  });

  test("unsigned reasoning keeps provenance by step id within its owning message", () => {
    const stepProvenance = knownProvenance(anthropicModel);
    const owning = message([
      {
        type: "thinking",
        content: "First",
        stepId: "step-1",
        provenance: knownProvenance(model),
      },
      {
        type: "thinking",
        content: "Second",
        stepId: "step-2",
        provenance: stepProvenance,
      },
    ]);
    const stamped = stampReasoningProvenance({
      message: message([
        { type: "thinking", content: "Second continued", stepId: "step-2" },
      ]),
      model,
      initialMessages: [owning],
    });
    expect(stamped.parts.at(0)).toEqual({
      type: "thinking",
      content: "Second continued",
      stepId: "step-2",
      provenance: stepProvenance,
    });
  });

  test("signed reasoning keeps its provenance from an equal signature in another message", () => {
    const provenance = knownProvenance({ ...model, signature });
    const stamped = stampReasoningProvenance({
      message: laterMessage([thinking]),
      model: anthropicModel,
      initialMessages: [message([{ ...thinking, provenance }])],
    });
    expect(stamped.parts.at(0)).toEqual({ ...thinking, provenance });
  });
});

describe("reasoning from models outside the catalog", () => {
  test("reasoning from a model the catalog does not describe stays unreplayable instead of failing the turn", () => {
    const unlisted = { provider: "openai", modelId: "unlisted-model" } as const;
    expect(reasoningProvenanceForSignature({ ...unlisted, signature })).toBe(
      undefined,
    );
    const call = {
      type: "tool-call",
      id: "call_1",
      name: "mcp__search",
      arguments: "{}",
      state: "complete",
      metadata: { thoughtSignature: "signed" },
    } as const;
    const stamped = stampReasoningProvenance({
      message: laterMessage([thinking, call]),
      model: unlisted,
      initialMessages: [],
    });
    expect(stamped.parts).toEqual([thinking, call]);
  });
});

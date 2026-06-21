import { describe, expect, test } from "bun:test";

import type { AISuggestion } from "@stll/folio";

import {
  anchorSuggestion,
  buildGenerateInput,
  deriveChatStatus,
  joinPromptWithPasted,
  parseStoredApplyMode,
  resolveAcceptGroupGate,
  resolveAcceptOneGate,
  resolveApplyMode,
  selectResponseSuggestions,
} from "./host.logic";

const baseSuggestion: AISuggestion = {
  id: "s1",
  topic: "Clarity",
  severity: "style",
  range: { from: 4, to: 10 },
  originalText: "old",
  suggestedText: "new",
  contextBefore: "",
  contextAfter: "",
  rationale: "",
  status: "pending",
};

describe("parseStoredApplyMode", () => {
  test("accepts the two known modes verbatim", () => {
    expect(parseStoredApplyMode("direct")).toBe("direct");
    expect(parseStoredApplyMode("tracked-changes")).toBe("tracked-changes");
  });

  test("rejects null, empty, and unknown values", () => {
    expect(parseStoredApplyMode(null)).toBeNull();
    expect(parseStoredApplyMode("")).toBeNull();
    expect(parseStoredApplyMode("Direct")).toBeNull();
    expect(parseStoredApplyMode("tracked")).toBeNull();
  });
});

describe("resolveApplyMode", () => {
  test("prefers the stored preference over everything", () => {
    expect(resolveApplyMode("tracked-changes", "direct")).toBe(
      "tracked-changes",
    );
    expect(resolveApplyMode("direct", "tracked-changes")).toBe("direct");
  });

  test("falls back to the host default when nothing is stored", () => {
    expect(resolveApplyMode(null, "tracked-changes")).toBe("tracked-changes");
  });

  test("falls back to direct when neither stored nor default is set", () => {
    expect(resolveApplyMode(null, undefined)).toBe("direct");
  });
});

describe("deriveChatStatus", () => {
  test("generating wins over pending suggestions", () => {
    expect(deriveChatStatus(true, 0)).toBe("generating");
    expect(deriveChatStatus(true, 5)).toBe("generating");
  });

  test("review-ready when not generating but suggestions are pending", () => {
    expect(deriveChatStatus(false, 1)).toBe("review-ready");
  });

  test("idle when not generating and nothing pending", () => {
    expect(deriveChatStatus(false, 0)).toBe("idle");
  });
});

describe("resolveAcceptOneGate", () => {
  test("defers the accept when no mode is stored and the target is pending", () => {
    expect(resolveAcceptOneGate(null, "s1", true)).toEqual({
      type: "defer",
      pending: { kind: "one", suggestionId: "s1" },
    });
  });

  test("noops when no mode is stored and the target is not pending", () => {
    expect(resolveAcceptOneGate(null, "s1", false)).toEqual({ type: "noop" });
  });

  test("accepts immediately once a mode is stored, regardless of pending", () => {
    expect(resolveAcceptOneGate("direct", "s1", true)).toEqual({
      type: "accept",
    });
    expect(resolveAcceptOneGate("tracked-changes", "s1", false)).toEqual({
      type: "accept",
    });
  });
});

describe("resolveAcceptGroupGate", () => {
  test("defers the accept when no mode is stored and the message has pending", () => {
    expect(resolveAcceptGroupGate(null, "m1", true)).toEqual({
      type: "defer",
      pending: { kind: "group", messageId: "m1" },
    });
  });

  test("noops when no mode is stored and the message has no pending", () => {
    expect(resolveAcceptGroupGate(null, "m1", false)).toEqual({ type: "noop" });
  });

  test("accepts immediately once a mode is stored", () => {
    expect(resolveAcceptGroupGate("direct", "m1", true)).toEqual({
      type: "accept",
    });
    expect(resolveAcceptGroupGate("tracked-changes", "m1", false)).toEqual({
      type: "accept",
    });
  });
});

describe("joinPromptWithPasted", () => {
  test("leaves the prompt untouched when there is no pasted text", () => {
    expect(joinPromptWithPasted("hello", undefined)).toBe("hello");
    expect(joinPromptWithPasted("hello", "")).toBe("hello");
  });

  test("uses just the pasted text when the prompt is empty", () => {
    expect(joinPromptWithPasted("", "pasted body")).toBe("pasted body");
  });

  test("joins prompt and pasted text with a blank line", () => {
    expect(joinPromptWithPasted("question", "pasted body")).toBe(
      "question\n\npasted body",
    );
  });
});

describe("buildGenerateInput", () => {
  const common = {
    fullPrompt: "do the thing",
    mode: "edit" as const,
    selectionText: "sel",
    selectionRange: { from: 1, to: 3 },
    cursorPosition: { from: 1, to: 1 },
    documentText: "the whole doc",
    visibleText: "visible part",
    visibleRange: { from: 0, to: 50 },
  };

  test("maps the extracted values straight onto the payload", () => {
    expect(buildGenerateInput({ ...common, presetId: undefined })).toEqual({
      prompt: "do the thing",
      mode: "edit",
      selectionText: "sel",
      selectionRange: { from: 1, to: 3 },
      cursorPosition: { from: 1, to: 1 },
      documentText: "the whole doc",
      visibleText: "visible part",
      visibleRange: { from: 0, to: 50 },
    });
  });

  test("omits presetId entirely when it is undefined", () => {
    const out = buildGenerateInput({ ...common, presetId: undefined });
    expect("presetId" in out).toBe(false);
  });

  test("includes presetId when present", () => {
    const out = buildGenerateInput({ ...common, presetId: "summarize" });
    expect(out.presetId).toBe("summarize");
  });

  test("threads null ranges through (PDF / no selection)", () => {
    const out = buildGenerateInput({
      ...common,
      selectionRange: null,
      cursorPosition: null,
      visibleRange: null,
      presetId: undefined,
    });
    expect(out.selectionRange).toBeNull();
    expect(out.cursorPosition).toBeNull();
    expect(out.visibleRange).toBeNull();
  });
});

describe("selectResponseSuggestions", () => {
  test("drops all suggestions in ask mode", () => {
    expect(selectResponseSuggestions("ask", [baseSuggestion])).toEqual([]);
  });

  test("keeps the response list in edit mode", () => {
    expect(selectResponseSuggestions("edit", [baseSuggestion])).toEqual([
      baseSuggestion,
    ]);
  });

  test("collapses a missing list to empty in edit mode", () => {
    expect(selectResponseSuggestions("edit", undefined)).toEqual([]);
  });
});

describe("anchorSuggestion", () => {
  test("keeps the suggestion verbatim when no editor view (anchor undefined)", () => {
    expect(anchorSuggestion(baseSuggestion, undefined)).toBe(baseSuggestion);
  });

  test("marks the suggestion stale when the anchor lookup fails (null)", () => {
    const out = anchorSuggestion(baseSuggestion, null);
    expect(out.status).toBe("stale");
    expect(out.range).toEqual(baseSuggestion.range);
  });

  test("re-anchors the range when an anchor is resolved", () => {
    const out = anchorSuggestion(baseSuggestion, { from: 20, to: 30 });
    expect(out.range).toEqual({ from: 20, to: 30 });
    expect(out.status).toBe("pending");
  });
});

/**
 * Unit tests for the AI suggestion decoration plugin's state keeping,
 * focused on range remapping through doc edits: both the inline
 * decorations and the paged editor's projected overlay read the
 * suggestion ranges from this state, so a stale range after an edit
 * would strike through (or replace) the wrong text.
 */

import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";

import type { AISuggestion } from "../../ai-suggestions/types";
import { schema } from "../schema";
import {
  aiSuggestionDecorationsKey,
  createAISuggestionDecorationsPlugin,
  setAISuggestionsMeta,
  setFocusedSuggestionMeta,
} from "./aiSuggestionDecorations";

const docOf = (...paragraphs: string[]): PMNode =>
  schema.node(
    "doc",
    null,
    paragraphs.map((text) =>
      schema.node("paragraph", null, text ? [schema.text(text)] : null),
    ),
  );

const suggestionAt = (
  from: number,
  to: number,
  overrides: Partial<AISuggestion> = {},
): AISuggestion => ({
  id: "s1",
  topic: "wording",
  severity: "style",
  range: { from, to },
  originalText: "",
  suggestedText: "replacement",
  contextBefore: "",
  contextAfter: "",
  rationale: "",
  status: "pending",
  ...overrides,
});

const makeState = (doc: PMNode, suggestions: AISuggestion[]): EditorState => {
  const plugin = createAISuggestionDecorationsPlugin();
  const state = EditorState.create({ doc, plugins: [plugin] });
  const { key, payload } = setAISuggestionsMeta(suggestions);
  return state.apply(state.tr.setMeta(key, payload));
};

const getRanges = (state: EditorState): { from: number; to: number }[] =>
  (aiSuggestionDecorationsKey.getState(state)?.suggestions ?? []).map(
    (s) => s.range,
  );

const sliceFromTo = (doc: PMNode, from: number, to: number): string =>
  doc.textBetween(from, to, "");

describe("aiSuggestionDecorations: range remapping", () => {
  // "The tenant shall pay rent." — "tenant" spans [5, 11).
  const baseDoc = docOf("The tenant shall pay rent.");

  test("an insertion before the range shifts it", () => {
    let state = makeState(baseDoc, [suggestionAt(5, 11)]);
    expect(sliceFromTo(state.doc, 5, 11)).toBe("tenant");

    state = state.apply(state.tr.insertText("Note: ", 1));

    const [range] = getRanges(state);
    expect(range).toBeDefined();
    expect(sliceFromTo(state.doc, range!.from, range!.to)).toBe("tenant");
  });

  test("an insertion at the range edges stays outside it", () => {
    let state = makeState(baseDoc, [suggestionAt(5, 11)]);

    // Matches the non-inclusive inline decoration: text typed at either
    // boundary belongs to the surrounding prose, not the suggestion.
    state = state.apply(state.tr.insertText("X", 5));
    state = state.apply(state.tr.insertText("Y", getRanges(state)[0]!.to));

    const [range] = getRanges(state);
    expect(sliceFromTo(state.doc, range!.from, range!.to)).toBe("tenant");
  });

  test("deleting the whole range collapses it (no decoration painted)", () => {
    let state = makeState(baseDoc, [suggestionAt(5, 11)]);

    state = state.apply(state.tr.delete(5, 11));

    const [range] = getRanges(state);
    expect(range!.from).toBe(range!.to);
  });

  test("a doc edit with no suggestions keeps the state object identity", () => {
    const plugin = createAISuggestionDecorationsPlugin();
    let state = EditorState.create({ doc: baseDoc, plugins: [plugin] });
    const before = aiSuggestionDecorationsKey.getState(state);

    state = state.apply(state.tr.insertText("X", 1));

    expect(aiSuggestionDecorationsKey.getState(state)).toBe(before!);
  });
});

describe("aiSuggestionDecorations: decoration building", () => {
  const baseDoc = docOf("The tenant shall pay rent.");

  test("a pending suggestion gets one inline decoration; focusing adds the replacement widget", () => {
    let state = makeState(baseDoc, [suggestionAt(5, 11)]);
    const decorationsBefore =
      aiSuggestionDecorationsKey.getState(state)?.decorationSet.find() ?? [];
    expect(decorationsBefore).toHaveLength(1);

    const { key, payload } = setFocusedSuggestionMeta("s1");
    state = state.apply(state.tr.setMeta(key, payload));

    const decorationsAfter =
      aiSuggestionDecorationsKey.getState(state)?.decorationSet.find() ?? [];
    expect(decorationsAfter).toHaveLength(2);
  });

  test("a focused pure deletion (empty suggestedText) adds no widget", () => {
    let state = makeState(baseDoc, [
      suggestionAt(5, 11, { suggestedText: "" }),
    ]);
    const { key, payload } = setFocusedSuggestionMeta("s1");
    state = state.apply(state.tr.setMeta(key, payload));

    const decorations =
      aiSuggestionDecorationsKey.getState(state)?.decorationSet.find() ?? [];
    expect(decorations).toHaveLength(1);
  });

  test("non-pending suggestions are not decorated", () => {
    const state = makeState(baseDoc, [
      suggestionAt(5, 11, { status: "accepted" }),
    ]);
    const decorations =
      aiSuggestionDecorationsKey.getState(state)?.decorationSet.find() ?? [];
    expect(decorations).toHaveLength(0);
  });
});

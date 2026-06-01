/**
 * Unit tests for Suggestion Mode Plugin
 */

import { describe, test, expect } from "bun:test";
import { history, undo } from "prosemirror-history";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  createSuggestionModePlugin,
  suggestionModeKey,
  setSuggestionMode,
  handleSuggestionEnter,
} from "./suggestionMode";

// Minimal schema with insertion/deletion marks
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
  marks: {
    insertion: {
      attrs: {
        revisionId: { default: 0 },
        author: { default: "" },
        date: { default: "" },
      },
      toDOM: () => ["ins", 0],
    },
    deletion: {
      attrs: {
        revisionId: { default: 0 },
        author: { default: "" },
        date: { default: "" },
      },
      toDOM: () => ["del", 0],
    },
  },
});

function createState(text: string, active = false): EditorState {
  const plugin = createSuggestionModePlugin(active, "TestUser");
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text(text)]),
  ]);
  return EditorState.create({ doc, plugins: [plugin] });
}

function getPluginState(state: EditorState) {
  return suggestionModeKey.getState(state);
}

function getText(state: EditorState): string {
  let text = "";
  state.doc.descendants((node) => {
    if (node.isText) {
      text += node.text;
    }
  });
  return text;
}

function getMarks(state: EditorState): { text: string; marks: string[] }[] {
  const result: { text: string; marks: string[] }[] = [];
  state.doc.descendants((node) => {
    if (node.isText) {
      result.push({
        text: node.text ?? "",
        marks: node.marks.map((m) => m.type.name),
      });
    }
  });
  return result;
}

describe("SuggestionMode Plugin", () => {
  describe("plugin state", () => {
    test("initializes with active=false by default", () => {
      const state = createState("Hello");
      expect(getPluginState(state)?.active).toBe(false);
    });

    test("initializes with active=true when specified", () => {
      const state = createState("Hello", true);
      expect(getPluginState(state)?.active).toBe(true);
    });

    test("setSuggestionMode toggles active state", () => {
      const state = createState("Hello");
      expect(getPluginState(state)?.active).toBe(false);

      // Activate
      const dispatched = { state: null as EditorState | null };
      setSuggestionMode(true, state, (tr) => {
        dispatched.state = state.apply(tr);
      });
      expect(dispatched.state).not.toBeNull();
      if (dispatched.state === null) {
        throw new Error("Expected dispatched state");
      }
      expect(getPluginState(dispatched.state)?.active).toBe(true);
    });
  });

  describe("handleTextInput", () => {
    test("plugin state is preserved after selection change", () => {
      const state = createState("Hello", true);
      const sel = TextSelection.create(state.doc, 6);
      const stateWithCursor = state.apply(state.tr.setSelection(sel));

      // The handleTextInput is a view-level prop, can't easily test without a view
      // Instead, test the state logic directly
      expect(getPluginState(stateWithCursor)?.active).toBe(true);
    });
  });

  describe("selection delete (markRangeAsDeleted)", () => {
    test("selection backspace marks text as deletion when active", () => {
      // Create state with suggestion mode active
      const plugin = createSuggestionModePlugin(true, "TestUser");
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("Hello World")]),
      ]);
      let state = EditorState.create({ doc, plugins: [plugin] });

      // Verify plugin state is active
      const pluginState = getPluginState(state);
      expect(pluginState?.active).toBe(true);
      expect(pluginState?.author).toBe("TestUser");

      // Select "World" (positions 7-12)
      const sel = TextSelection.create(state.doc, 7, 12);
      state = state.apply(state.tr.setSelection(sel));

      // Verify selection
      expect(state.selection.from).toBe(7);
      expect(state.selection.to).toBe(12);
      expect(state.selection.empty).toBe(false);

      // Now simulate what handleSuggestionDelete does for a selection delete
      const insertionType = state.schema.marks.insertion;
      const deletionType = state.schema.marks.deletion;
      const tr = state.tr;
      tr.setMeta("suggestionModeApplied", true);

      // Mark range as deleted (inline version of markRangeAsDeleted)
      const from = state.selection.from;
      const to = state.selection.to;

      const ranges: { from: number; to: number; isOwnInsert: boolean }[] = [];
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) {
          return;
        }
        const start = Math.max(pos, from);
        const end = Math.min(pos + node.nodeSize, to);
        if (start >= end) {
          return;
        }
        const isOwnInsert = node.marks.some(
          (m) => m.type === insertionType && m.attrs.author === "TestUser",
        );
        ranges.push({ from: start, to: end, isOwnInsert });
      });

      expect(ranges.length).toBeGreaterThan(0);
      expect(ranges[0].isOwnInsert).toBe(false);

      // Apply deletion marks (not actual deletion)
      for (let i = ranges.length - 1; i >= 0; i--) {
        const range = ranges[i];
        if (range.isOwnInsert) {
          tr.delete(range.from, range.to);
        } else {
          tr.addMark(
            range.from,
            range.to,
            deletionType.create({
              revisionId: 123,
              author: "TestUser",
              date: new Date().toISOString(),
            }),
          );
        }
      }

      const newState = state.apply(tr);

      // Text should still be present (marked, not deleted)
      expect(getText(newState)).toBe("Hello World");

      // "World" should have deletion mark
      const marks = getMarks(newState);
      const worldEntry = marks.find((m) => m.text.includes("World"));
      expect(worldEntry).toBeDefined();
      expect(worldEntry?.marks).toContain("deletion");
    });
  });

  describe("history undo/redo", () => {
    test("does not mark text as inserted when undoing a tracked Enter split (issue #633)", () => {
      const plugin = createSuggestionModePlugin(true, "TestUser");
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("abcdef")]),
      ]);

      let state = EditorState.create({
        doc,
        plugins: [history(), plugin],
      });

      // Mocks the EditorView's minimal state/dispatch interface for testing.
      // SAFETY: This mock implements only the subset of EditorView needed by the suggestion mode plugin.
      const mockView = {
        state,
        dispatch(tr: Transaction) {
          state = state.apply(tr);
          this.state = state;
        },
      } as unknown as EditorView;

      // Move cursor between "abc" and "def" (position 4)
      const sel = TextSelection.create(state.doc, 4);
      state = state.apply(state.tr.setSelection(sel));
      mockView.state = state;

      // Press Enter 3 times
      for (let i = 0; i < 3; i++) {
        const pluginState = suggestionModeKey.getState(state);
        handleSuggestionEnter(mockView, pluginState);
      }

      // Check document structure
      expect(state.doc.childCount).toBe(4);
      expect(getText(state)).toBe("abcdef");

      // Verify no insertion marks exist before undo
      const marksBeforeUndo = getMarks(state);
      expect(
        marksBeforeUndo.filter((m) => m.marks.includes("insertion")).length,
      ).toBe(0);

      // Helper function to perform undo and capture state update without function-in-loop warning
      function performUndo() {
        let undoDispatched = false;
        undo(state, (undoTr) => {
          state = state.apply(undoTr);
          undoDispatched = true;
        });
        return undoDispatched;
      }

      // Undo all Enters in a loop
      while (state.doc.childCount > 1) {
        expect(performUndo()).toBe(true);
      }

      // The text should still be intact and NOT carry any insertion marks
      expect(getText(state)).toBe("abcdef");
      const marksAfterUndo = getMarks(state);
      const insertedText = marksAfterUndo.filter((m) =>
        m.marks.includes("insertion"),
      );
      expect(insertedText.length).toBe(0);
    });
  });
});

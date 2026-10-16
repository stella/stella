import type { Decoration } from "@tiptap/core";
import { InlineDecoration } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { describe, expect, test } from "bun:test";

import type { ChatAnonPair } from "@stll/anonymize-chat";

import {
  buildChatAnonDecorations,
  ChatAnonDecorations,
  setChatAnonDecorationPairs,
} from "./chat-anon-decorations-extension";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});

const inlineSpans = (decorations: readonly Decoration[]) =>
  decorations.map((decoration) => {
    if (!(decoration instanceof InlineDecoration)) {
      throw new Error("chat anon decorations must be inline");
    }
    return {
      from: decoration.from,
      to: decoration.to,
      placeholder: decoration.attrs["data-ph"],
    };
  });

describe("buildChatAnonDecorations", () => {
  test("maps pair matches across paragraphs to document positions, preferring the longest original", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("Jan Novák met Jan at Acme (s.r.o.)"),
      ]),
      schema.node("paragraph", null, [schema.text("Call Jan Novák")]),
    ]);
    // Deliberately unsorted: "Jan" precedes its superstring "Jan Novák" so
    // the longest-first ordering inside the builder is what's under test.
    // "Acme (s.r.o.)" carries regex specials that must match literally.
    const pairs = [
      { label: "person", original: "Jan", placeholder: "[PERSON_2]" },
      { label: "person", original: "Jan Novák", placeholder: "[PERSON_1]" },
      {
        label: "organization",
        original: "Acme (s.r.o.)",
        placeholder: "[ORGANIZATION_1]",
      },
    ] as const satisfies readonly ChatAnonPair[];

    const decorations = buildChatAnonDecorations(doc, pairs);

    expect(inlineSpans(decorations)).toEqual([
      { from: 1, to: 10, placeholder: "[PERSON_1]" },
      { from: 15, to: 18, placeholder: "[PERSON_2]" },
      { from: 22, to: 35, placeholder: "[ORGANIZATION_1]" },
      { from: 42, to: 51, placeholder: "[PERSON_1]" },
    ]);
    for (const decoration of decorations) {
      if (decoration instanceof InlineDecoration) {
        expect(decoration.attrs.class).toBe("stll-anon-highlight");
      }
    }
  });

  test("decorates nothing without pairs", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Jan Novák")]),
    ]);

    expect(buildChatAnonDecorations(doc, [])).toEqual([]);
  });
});

describe("setChatAnonDecorationPairs", () => {
  const pairs = [
    { label: "person", original: "Jan Novák", placeholder: "[PERSON_1]" },
  ] as const satisfies readonly ChatAnonPair[];

  test("stores the pairs and recomputes only its own decorations on a live editor", () => {
    const storage = { stllAnonDecorations: { pairs: [] } };
    const updated: (string | undefined)[] = [];
    const editor = {
      commands: {
        updateDecorations: (extensionName?: string) => {
          updated.push(extensionName);
          return true;
        },
      },
      isDestroyed: false,
      storage,
    };

    setChatAnonDecorationPairs(editor, pairs);

    expect(storage.stllAnonDecorations.pairs).toBe(pairs);
    expect(updated).toEqual([ChatAnonDecorations.name]);
  });

  test("leaves a destroyed editor's storage and commands untouched", () => {
    const editor = {
      get commands(): never {
        throw new TypeError("view is gone");
      },
      isDestroyed: true,
      get storage(): never {
        throw new TypeError("view is gone");
      },
    };

    expect(() => setChatAnonDecorationPairs(editor, pairs)).not.toThrow();
  });
});

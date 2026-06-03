/**
 * Block-content fill via the editor-ref transaction helper.
 */

import { describe, expect, test } from "bun:test";
import { EditorState } from "prosemirror-state";

import type { BlockContent } from "../../types/document";
import { schema, singletonManager } from "../schema";
import { setContentControlContentBlocksTr } from "./contentControlsBlockFill";

function makeState() {
  const sdt = schema.node("blockSdt", { sdtType: "richText", tag: "clause" }, [
    schema.node("paragraph", {}, [schema.text("placeholder")]),
  ]);
  return EditorState.create({
    doc: schema.node("doc", null, [sdt]),
    schema,
    plugins: [...singletonManager.getPlugins()],
  });
}

describe("setContentControlContentBlocksTr", () => {
  test("replaces SDT children with the PM form of a multi-paragraph fill", () => {
    const blocks: BlockContent[] = [
      {
        type: "paragraph",
        content: [
          { type: "run", content: [{ type: "text", text: "First line" }] },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "run", content: [{ type: "text", text: "Second line" }] },
        ],
      },
    ];

    const state = makeState();
    const tr = setContentControlContentBlocksTr(
      state,
      { tag: "clause" },
      blocks,
    );
    if (!tr) {
      throw new Error("expected a transaction");
    }
    const next = state.apply(tr);
    const sdt = next.doc.firstChild;
    expect(sdt?.type.name).toBe("blockSdt");
    expect(sdt?.childCount).toBe(2);
    expect(sdt?.child(0).textContent).toBe("First line");
    expect(sdt?.child(1).textContent).toBe("Second line");
  });

  test("accepts a table in the fill input and emits it as a PM child", () => {
    const blocks: BlockContent[] = [
      {
        type: "table",
        columnWidths: [2400, 2400],
        rows: [
          {
            type: "tableRow",
            cells: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "run",
                        content: [{ type: "text", text: "left" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "run",
                        content: [{ type: "text", text: "right" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const state = makeState();
    const tr = setContentControlContentBlocksTr(
      state,
      { tag: "clause" },
      blocks,
    );
    if (!tr) {
      throw new TypeError("expected a transaction");
    }
    const next = state.apply(tr);
    const sdt = next.doc.firstChild;
    expect(sdt?.type.name).toBe("blockSdt");
    expect(sdt?.firstChild?.type.name).toBe("table");
  });

  test("does not pad fill input ending in a nested blockSdt with a blank paragraph", () => {
    // Codex P2 (PR #587): headerFooterToProseDoc used to append a
    // trailing empty paragraph after any final blockSdt to provide a
    // caret slot. That meant a caller replacing a control with exactly
    // one nested content control silently got an extra empty paragraph
    // inside the outer SDT. The caret affordance is provided by
    // gapcursor; the converter no longer pads.
    const blocks: BlockContent[] = [
      {
        type: "blockSdt",
        properties: { sdtType: "richText", tag: "nested" },
        content: [
          {
            type: "paragraph",
            content: [
              { type: "run", content: [{ type: "text", text: "inner" }] },
            ],
          },
        ],
      },
    ];
    const state = makeState();
    const tr = setContentControlContentBlocksTr(
      state,
      { tag: "clause" },
      blocks,
    );
    if (!tr) {
      throw new TypeError("expected a transaction");
    }
    const next = state.apply(tr);
    const outer = next.doc.firstChild;
    expect(outer?.type.name).toBe("blockSdt");
    // Exactly one child (the nested blockSdt), no trailing empty paragraph.
    expect(outer?.childCount).toBe(1);
    expect(outer?.firstChild?.type.name).toBe("blockSdt");
    expect(outer?.firstChild?.attrs["tag"]).toBe("nested");
  });

  test("returns null when no control matches the filter", () => {
    const state = makeState();
    expect(
      setContentControlContentBlocksTr(state, { tag: "missing" }, []),
    ).toBeNull();
  });
});

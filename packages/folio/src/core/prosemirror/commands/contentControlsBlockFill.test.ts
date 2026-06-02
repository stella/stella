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

  test("returns null when no control matches the filter", () => {
    const state = makeState();
    expect(
      setContentControlContentBlocksTr(state, { tag: "missing" }, []),
    ).toBeNull();
  });
});

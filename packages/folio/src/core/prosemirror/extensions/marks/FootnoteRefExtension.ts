/**
 * Footnote Reference Mark Extension
 *
 * Provides footnoteRef mark + insert/delete commands for footnotes and endnotes.
 */

import { panic } from "better-result";
import type { Command } from "prosemirror-state";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const FootnoteRefExtension = createMarkExtension({
  name: "footnoteRef",
  schemaMarkName: "footnoteRef",
  markSpec: {
    attrs: {
      id: {},
      noteType: { default: "footnote" },
    },
    parseDOM: [
      {
        tag: "sup.docx-footnote-ref",
        getAttrs: (dom) => ({
          id: dom.dataset["id"] ?? "",
          noteType: dom.dataset["noteType"] ?? "footnote",
        }),
      },
    ],
    toDOM(mark) {
      // SAFETY: FootnoteRef attrs always have id/noteType per schema
      const id = String(mark.attrs["id"]);
      const noteType = String(mark.attrs["noteType"]);
      return [
        "sup",
        {
          class: `docx-${noteType}-ref`,
          "data-id": id,
          "data-note-type": noteType,
        },
        0,
      ];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const { schema } = ctx;

    function makeInsertNote(
      noteType: "footnote" | "endnote",
    ): (id: number) => Command {
      return (id: number): Command =>
        (state, dispatch) => {
          if (!dispatch) {
            return true;
          }

          const footnoteRefType = schema.marks["footnoteRef"];
          if (!footnoteRefType) {
            panic("Missing mark type: footnoteRef");
          }
          const mark = footnoteRefType.create({
            id: String(id),
            noteType,
          });
          const text = schema.text(String(id), [mark]);
          const tr = state.tr.replaceSelectionWith(text, false);
          dispatch(tr.scrollIntoView());
          return true;
        };
    }

    const deleteNoteRef: Command = (state, dispatch) => {
      const { $from, $to } = state.selection;
      if (!dispatch) {
        return true;
      }

      let tr = state.tr;
      const markType = schema.marks["footnoteRef"];

      // Remove footnoteRef marks in selection range
      tr = tr.removeMark($from.pos, $to.pos, markType);
      dispatch(tr.scrollIntoView());
      return true;
    };

    return {
      commands: {
        insertFootnote: makeInsertNote("footnote"),
        insertEndnote: makeInsertNote("endnote"),
        deleteNoteRef: () => deleteNoteRef,
      },
    };
  },
});

import { describe, expect, test } from "bun:test";
import * as yProseMirror from "y-prosemirror";
import * as yjs from "yjs";

import { toProseDoc } from "../core/prosemirror/conversion";
import type { Document } from "../core/types/document";
import { createHiddenEditorState } from "./HiddenProseMirror";

const docWithoutParaIds = (): Document => ({
  package: {
    document: {
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "run",
              content: [{ type: "text", text: "Needs an id" }],
            },
          ],
        },
      ],
    },
  },
});

const collectParaIds = (
  state: ReturnType<typeof createHiddenEditorState>,
): string[] => {
  const ids: string[] = [];
  state.doc.descendants((node) => {
    if (node.type.name !== "paragraph") {
      return true;
    }
    const id = node.attrs["paraId"];
    if (typeof id === "string") {
      ids.push(id);
    }
    return false;
  });
  return ids;
};

const collaborationModules = { yProseMirror, yjs };

describe("createHiddenEditorState collaborative paraId allocation", () => {
  test("seeds a collaborative fragment with allocated paraIds", () => {
    const ydoc = new yjs.Doc();
    const yXmlFragment = ydoc.get("prosemirror", yjs.XmlFragment);

    const state = createHiddenEditorState(
      docWithoutParaIds(),
      null,
      undefined,
      [],
      { shouldSeed: true, yXmlFragment },
      collaborationModules,
    );

    expect(collectParaIds(state)[0]).toMatch(/^[0-9A-F]{8}$/u);

    const reloaded = createHiddenEditorState(
      null,
      null,
      undefined,
      [],
      { shouldSeed: false, yXmlFragment },
      collaborationModules,
    );
    expect(collectParaIds(reloaded)[0]).toMatch(/^[0-9A-F]{8}$/u);
  });

  test("allocates paraIds when opening an existing collaborative fragment", () => {
    const ydoc = new yjs.Doc();
    const yXmlFragment = ydoc.get("prosemirror", yjs.XmlFragment);
    yProseMirror.prosemirrorToYXmlFragment(
      toProseDoc(docWithoutParaIds()),
      yXmlFragment,
    );

    const state = createHiddenEditorState(
      null,
      null,
      undefined,
      [],
      { shouldSeed: false, yXmlFragment },
      collaborationModules,
    );

    expect(collectParaIds(state)[0]).toMatch(/^[0-9A-F]{8}$/u);

    const reloaded = createHiddenEditorState(
      null,
      null,
      undefined,
      [],
      { shouldSeed: false, yXmlFragment },
      collaborationModules,
    );
    expect(collectParaIds(reloaded)[0]).toMatch(/^[0-9A-F]{8}$/u);
  });
});

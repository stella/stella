import { useState } from "react";
import { createRoot } from "react-dom/client";

import { SelectionToolbar } from "../../src/components/selection-toolbar";
import { selectionToolbarAnchor } from "../../src/components/selection-toolbar.logic";
import type { SelectionToolbarAnchor } from "../../src/components/selection-toolbar.logic";

const sourceText =
  "A selected passage remains attached to its words while the reader moves through the document. ";
const Fixture = () => {
  const [anchor, setAnchor] = useState<SelectionToolbarAnchor | null>(null);
  const showSelection = (
    root: HTMLElement,
    pointer?: { x: number; y: number },
  ) => {
    const selection = window.document.getSelection();
    if (selection === null || selection.rangeCount === 0) {
      return;
    }
    setAnchor(
      selectionToolbarAnchor({
        range: selection.getRangeAt(0),
        root,
        ...(pointer === undefined ? {} : { pointer }),
      }),
    );
  };
  return (
    <>
      <header style={{ height: 100, background: "#eee" }}>Header</header>
      <main style={{ padding: 28 }}>
        <div
          data-testid="pane"
          style={{
            width: 280,
            height: 320,
            overflow: "auto",
            fontSize: 16,
            lineHeight: "24px",
          }}
          ref={(node) => {
            if (node === null) {
              return undefined;
            }
            const pointerUp = (event: PointerEvent) =>
              showSelection(node, { x: event.clientX, y: event.clientY });
            const keyUp = () => showSelection(node);
            node.addEventListener("pointerup", pointerUp);
            node.addEventListener("keyup", keyUp);
            return () => {
              node.removeEventListener("pointerup", pointerUp);
              node.removeEventListener("keyup", keyUp);
            };
          }}
        >
          {Array.from({ length: 12 }, (_, index) => (
            <p key={index} data-line={index} style={{ margin: "0 0 24px" }}>
              {sourceText.repeat(5)}
            </p>
          ))}
        </div>
      </main>
      {anchor !== null && (
        <SelectionToolbar
          ariaLabel="Selection actions"
          anchorRect={anchor.rect}
          boundaryRect={anchor.bounds}
          doc={window.document}
        >
          <button type="button" style={{ width: 210, height: 32 }}>
            Selection action
          </button>
        </SelectionToolbar>
      )}
    </>
  );
};
const container = window.document.querySelector("#fixture");
if (container !== null) {
  createRoot(container).render(<Fixture />);
}

import { useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Button } from "../button";
import { ComposerFrame } from "../composer-frame";
import { Textarea } from "../textarea";

// The compact composer at a docked chat's width (or `?width=`), with a real
// growing textarea, so the layout switch, the scroll region and the action
// row are measured from the browser's own layout.
const params = new URLSearchParams(window.location.search);
// A CSS length, so the query never needs converting to a number.
const width = `${params.get("width") ?? "360"}px`;

const ComposerFrameFixture = () => {
  const [draft, setDraft] = useState("");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-end p-4">
      <div style={{ width }}>
        <ComposerFrame
          empty={draft.length === 0}
          leading={
            <Button aria-label="Attach" size="icon-sm" variant="secondary">
              +
            </Button>
          }
          ring="focus"
          stature="compact"
          text={
            <Textarea
              appearance="composer"
              aria-label="Message"
              onChange={(event) => setDraft(event.currentTarget.value)}
              rows={1}
              value={draft}
            />
          }
          trailing={
            <Button aria-label="Send" size="icon-round" variant="composer">
              ↑
            </Button>
          }
        />
      </div>
    </main>
  );
};

document.documentElement.dir = params.get("dir") === "rtl" ? "rtl" : "ltr";

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<ComposerFrameFixture />);

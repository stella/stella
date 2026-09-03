import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Popover, PopoverPanel, PopoverTrigger } from "../popover";

// The editor is far wider than the picker it replaces, and the swap happens
// from local state while the popover stays open: the popup payload never
// changes, so nothing re-measures `--positioner-width`. Anchored `start`
// against a trigger at the inline end, the wide view only stays on screen if
// the positioner grows with the popup and collision handling shifts it back.
const VIEW_WIDTH_CLASS = {
  picker: "w-56",
  editor: "w-[44rem]",
} as const;

type PopoverView = keyof typeof VIEW_WIDTH_CLASS;

const PopoverResizeFixture = () => {
  const [view, setView] = useState<PopoverView>("picker");

  useEffect(() => {
    document.documentElement.dataset["popoverResizeReady"] = "true";
    return () => {
      delete document.documentElement.dataset["popoverResizeReady"];
    };
  }, []);

  return (
    <main className="flex justify-end p-2">
      <Popover
        onOpenChange={(open) => {
          if (!open) {
            setView("picker");
          }
        }}
      >
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverPanel align="start" className={VIEW_WIDTH_CLASS[view]}>
          {view === "picker" ? (
            <button onClick={() => setView("editor")} type="button">
              Edit
            </button>
          ) : (
            <p data-testid="editor">Wide editor view</p>
          )}
        </PopoverPanel>
      </Popover>
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<PopoverResizeFixture />);

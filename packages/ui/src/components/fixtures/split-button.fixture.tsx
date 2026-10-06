import { useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { MenuItem, MenuPopup } from "../menu";
import { PopoverPopup } from "../popover";
import { SplitButton } from "../split-button";
import { Textarea } from "../textarea";

const params = new URLSearchParams(window.location.search);

const SplitButtonFixture = () => {
  const [primaryCount, setPrimaryCount] = useState(0);
  const [menuCount, setMenuCount] = useState(0);
  const [open, setOpen] = useState(false);
  const sharedProps = {
    menuLabel: "More document actions",
    primaryDescriptionId: "primary-description",
    menuDescriptionId: "menu-description",
    primaryDisabled: params.get("disabled") === "primary",
    menuDisabled: params.get("disabled") === "menu",
    size: params.get("size") === "sm" ? "sm" : "md",
    open,
    onOpenChange: setOpen,
    onPrimaryClick: () => setPrimaryCount((count) => count + 1),
  } as const;

  let control;
  if (params.get("surface") === "popover") {
    control = (
      <SplitButton
        {...sharedProps}
        primaryLabel="Create document"
        surface="popover"
        menu={
          <PopoverPopup aria-label="Document question">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setMenuCount((count) => count + 1);
              }}
            >
              <button
                type="button"
                onClick={() => setMenuCount((count) => count + 1)}
              >
                Use a preset
              </button>
              <label htmlFor="question">Question</label>
              <Textarea id="question" />
              <button type="submit">Submit question</button>
            </form>
          </PopoverPopup>
        }
      >
        Create
      </SplitButton>
    );
  } else if (params.get("label") === "content") {
    control = (
      <SplitButton
        {...sharedProps}
        menu={
          <MenuPopup>
            <MenuItem>Create from template</MenuItem>
          </MenuPopup>
        }
      >
        Create document
      </SplitButton>
    );
  } else {
    control = (
      <SplitButton
        {...sharedProps}
        primaryLabel="Create document"
        surface="menu"
        menu={
          <MenuPopup>
            <MenuItem onClick={() => setMenuCount((count) => count + 1)}>
              Create from template
            </MenuItem>
          </MenuPopup>
        }
      >
        Create
      </SplitButton>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
      <button type="button">Before</button>
      {control}
      <button type="button">After</button>
      <span id="primary-description" hidden>
        Creates a blank document
      </span>
      <span id="menu-description" hidden>
        Additional document actions
      </span>
      <output aria-label="Primary actions" data-count={primaryCount} />
      <output aria-label="Menu actions" data-count={menuCount} />
      <output aria-label="Menu state">{open ? "open" : "closed"}</output>
    </main>
  );
};

document.documentElement.dir = params.get("dir") === "rtl" ? "rtl" : "ltr";

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<SplitButtonFixture />);

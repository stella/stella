import { useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { MenuItem, MenuPopup } from "../menu";
import { SplitButton } from "../split-button";

const params = new URLSearchParams(window.location.search);

const SplitButtonFixture = () => {
  const [primaryCount, setPrimaryCount] = useState(0);
  const [menuCount, setMenuCount] = useState(0);
  const [open, setOpen] = useState(false);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8">
      <button type="button">Before</button>
      <SplitButton
        primaryLabel="Create document"
        menuLabel="More document actions"
        primaryDisabled={params.get("disabled") === "primary"}
        menuDisabled={params.get("disabled") === "menu"}
        size={params.get("size") === "sm" ? "sm" : "md"}
        open={open}
        onOpenChange={setOpen}
        onPrimaryClick={() => setPrimaryCount((count) => count + 1)}
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
      <button type="button">After</button>
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

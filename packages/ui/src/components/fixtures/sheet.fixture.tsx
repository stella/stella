import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Sheet, SheetPopup, SheetTitle, SheetTrigger } from "../sheet";
import "./sheet.fixture.css";

const SheetFixture = () => (
  <main>
    <Sheet>
      <SheetTrigger>Full-width inspector</SheetTrigger>
      <SheetPopup
        className="h-dvh w-full max-w-none border-0"
        side="inline-end"
        showCloseButton={false}
      >
        <SheetTitle>Full-width inspector</SheetTitle>
        <div data-testid="inspector-content">Inspector content</div>
      </SheetPopup>
    </Sheet>
    <Sheet>
      <SheetTrigger>Normal-width sheet</SheetTrigger>
      <SheetPopup showCloseButton={false}>
        <SheetTitle>Normal-width sheet</SheetTitle>
        <div data-testid="normal-content">Sheet content</div>
      </SheetPopup>
    </Sheet>
  </main>
);

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing sheet fixture root");
}
createRoot(root).render(<SheetFixture />);
